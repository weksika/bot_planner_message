import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const users = new Set();
const userTodos = {}; // Хранилище для задач пользователей

// Получение значения из Google Sheets
async function getCellValue(cell) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}`;
    const res = await fetch(url);
    const data = await res.json(); // { value: "..." }
    return data.value;
  } catch (err) {
    console.error("Ошибка при получении данных из Google Sheets:", err);
    return null;
  }
}

// Запись значения в Google Sheets
async function setCellValue(cell, value) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}&value=${value}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.status === "ok";
  } catch (err) {
    console.error("Ошибка при записи в Google Sheets:", err);
    return false;
  }
}

// Генерация inline-клавиатуры для задач
function getTodoKeyboard(userId) {
  const todos = userTodos[userId] || [];
  return {
    reply_markup: {
      inline_keyboard: [
        ...todos.map((t, i) => [
          { text: `${t.done ? "✅" : "☑️"} ${t.text}`, callback_data: `toggle_${i}` },
        ]),
        [{ text: "Готово", callback_data: "done" }],
      ],
    },
  };
}

// Определяем колонку по дню недели
function editDate(date) {
  const weekday = date.getDay();
  switch (weekday) {
    case 1: return 'D';
    case 2: return 'J';
    case 3: return 'P';
    case 4: return 'V';
    case 5: return 'AB';
    case 6: return 'AH';
    case 0: return 'AN';
    default: return 'D';
  }
}

// Вычисление номера недели
function func_week_number(date){
  const dayOfMonth = date.getDate();
  let weekday = date.getDay();
  let week_number = 1;
  let vskr;
  if(dayOfMonth - weekday > 0 && weekday != 0){
   vskr = dayOfMonth - weekday;
   week_number = week_number + 1;
  } else {
    vskr = dayOfMonth + weekday;
  }
  for(let i = vskr; i > 7; i -= 7){
    week_number++;
  }
  return week_number;
}

// Отправка задач пользователю
async function sendDailyMessage(chatId, loadingMessage = null, dateStr = null) {
  const curDate = new Date();
  const wn = func_week_number(curDate);
  const str = editDate(curDate);

  // Колонка для чекбоксов (слева от текста)
  const numstr = str.length > 1 ? str[0] + String.fromCharCode(str.charCodeAt(1)-1) : String.fromCharCode(str.charCodeAt(0)-1);

  const userTasks = {};
  const numTasks = 8;

  for (let i = 1; i <= numTasks; i++) {
    const taskCell = `${str}${(2 + 10*wn) + i}`;
    const checkCell = `${numstr}${(2 + 10*wn) + i}`;

    const taskText = await getCellValue(taskCell);
    if (!taskText) continue; // игнорируем пустые задачи

    const taskCheckRaw = await getCellValue(checkCell);
    const taskDone = taskCheckRaw === true || taskCheckRaw === "TRUE" || taskCheckRaw === "1";

    userTasks[`task${i}`] = { text: taskText, done: taskDone };
  }

  const tasksArray = Object.values(userTasks);
  if (tasksArray.length === 0) {
    if (loadingMessage) {
      await bot.telegram.editMessageText(chatId, loadingMessage.message_id, null, `📅 Планы на ${dateStr} отсутствуют.`);
    }
    return;
  }

  userTodos[chatId] = tasksArray;

  // Формируем текст с задачами
  const tasksText = tasksArray.map(t => `${t.done ? "✅" : "☑️"} ${t.text}`).join("\n");
  const messageText = `📅 Планы на ${dateStr}:\n${tasksText}`;

  try {
    if (loadingMessage) {
      await bot.telegram.editMessageText(chatId, loadingMessage.message_id, null, messageText, getTodoKeyboard(chatId).reply_markup);
    } else {
      await bot.telegram.sendMessage(chatId, messageText, getTodoKeyboard(chatId));
    }
  } catch (err) {
    console.error("Ошибка при отправке сообщения:", err);
  }
}

// Команды бота
bot.start((ctx) => {
  ctx.reply("Привет! Я буду отправлять ежедневные уведомления.");
  users.add(ctx.from.id);
  console.log("Добавлен пользователь:", ctx.from.id);
});

bot.command("id", (ctx) => {
  ctx.reply(`Твой Telegram ID: ${ctx.from.id}`);
  users.add(ctx.from.id);
  console.log("Добавлен пользователь:", ctx.from.id);
});

bot.command("today", async (ctx) => {
  try {
    await ctx.sendChatAction("typing");
    const loadingMessage = await ctx.reply("⏳ Загружаю планы...");

    const curDate = new Date();
    const dateStr = curDate.toLocaleDateString("ru-RU", { weekday:"long", year:"numeric", month:"long", day:"numeric" });

    await sendDailyMessage(ctx.chat.id, loadingMessage, dateStr);
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Ошибка при загрузке планов");
  }
});

// Обработка нажатий чекбоксов
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  if (!userTodos[chatId]) return;

  if (data.startsWith("toggle_")) {
    const index = parseInt(data.split("_")[1]);
    const todo = userTodos[chatId][index];

    const curDate = new Date();
    const str = editDate(curDate);
    const wn = func_week_number(curDate);
    const numstr = str.length > 1 ? str[0] + String.fromCharCode(str.charCodeAt(1)-1) : String.fromCharCode(str.charCodeAt(0)-1);
    const row = (2 + 10*wn) + (index + 1);

    // Меняем локально
    todo.done = !todo.done;

    // Обновляем таблицу
    await setCellValue(`${numstr}${row}`, todo.done ? "TRUE" : "FALSE");

    // Обновляем клавиатуру
    await ctx.editMessageReplyMarkup(getTodoKeyboard(chatId).reply_markup);
    await ctx.answerCbQuery();
  }
});

// Запуск бота
bot.launch().then(() => console.log("🤖 Бот запущен!"));

// Ежедневный планировщик в 10:00
cron.schedule("0 10 * * *", () => {
  console.log("Отправляем ежедневное сообщение...");
  users.forEach(async (id) => {
    const curDate = new Date();
    const dateStr = curDate.toLocaleDateString("ru-RU", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    await sendDailyMessage(id, null, dateStr);
  });
});
