import fs from "fs";
import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const users = new Set();
function saveUsers() {
  fs.writeFileSync("users.json", JSON.stringify([...users], null, 2));
}

function loadUsers() {
  if (fs.existsSync("users.json")) {
    const data = JSON.parse(fs.readFileSync("users.json"));
    data.forEach(id => users.add(id));
  }
}

// Хранилище для дел пользователей
const userTodos = {};
loadUsers();
console.log("Загружены пользователи:", [...users]);
// Получение значения ячейки
export async function getCellValue(cell) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}`;
    const res = await fetch(url);
    const data = await res.json(); // { value: "текущее значение ячейки" }
    return data.value;
  } catch (err) {
    console.error("Ошибка при получении данных из Google Sheets:", err);
    return null;
  }
}

// Запись значения в ячейку
export async function setCellValue(cell, value) {
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

// Клавиатура для задач
function getTodoKeyboard(userId) {
  const todos = userTodos[userId] || [];
  return {
    reply_markup: {
      inline_keyboard: [
        ...todos.map((t, i) => [
          {
            text: `${t.done ? "✅" : "☑️"} ${t.text}`,
            callback_data: `toggle_${i}`,
          },
        ]),
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
function func_week_number(date) {
  const dayOfMonth = date.getDate();
  let weekday = date.getDay();
  let week_number = 1;
  let vskr;
  if(dayOfMonth - weekday > 0 && weekday != 0){
    vskr = dayOfMonth - weekday;
    week_number += 1;
  } else {
    vskr = dayOfMonth + weekday;
  }
  for(let i = vskr; i > 7; i -= 7){
    week_number++;
  }
  return week_number;
}

// Отправка задач
async function sendDailyMessage(chatId, loadingMessage = null, dateStr = null) {
  let curDate = new Date();
  let wn = func_week_number(curDate);
  let str = editDate(curDate);

  // Колонка для чекбокса
  let checkCol;
  if (str.length === 1) {
    checkCol = String.fromCharCode(str.charCodeAt(0) - 1);
  } else {
    checkCol = str[0] + String.fromCharCode(str.charCodeAt(1) - 1);
  }

  const userTasks = {};
  const numTasks = 8;

  for (let i = 1; i <= numTasks; i++) {
    const taskRow = (2 + (10 * wn)) + i;
    const taskCell = `${str}${taskRow}`;
    const checkCell = `${checkCol}${taskRow}`;

    const taskText = await getCellValue(taskCell);
    if (!taskText) continue;

    const taskCheckRaw = await getCellValue(checkCell);
    const taskDone = taskCheckRaw === true || taskCheckRaw === "TRUE" || taskCheckRaw === "1";

    userTasks[`task${i}`] = { text: taskText, done: taskDone, cell: checkCell };
  }

  const tasksArray = Object.values(userTasks);

  if (tasksArray.length === 0) {
    if (loadingMessage) {
      await bot.telegram.editMessageText(
        chatId,
        loadingMessage.message_id,
        undefined,
        `📅 Планы на ${dateStr} отсутствуют.`
      );
    }
    return;
  }

  if (!userTodos[chatId]) userTodos[chatId] = tasksArray;

  const messageText = `📅 Планы на ${dateStr}:`;

  try {
    if (loadingMessage) {
      await bot.telegram.editMessageText(
        chatId,
        loadingMessage.message_id,
        undefined,
        messageText,
        { reply_markup: getTodoKeyboard(chatId).reply_markup }
      );
    } else {
      await bot.telegram.sendMessage(
        chatId,
        messageText,
        getTodoKeyboard(chatId)
      );
    }
  } catch (err) {
    console.error("Ошибка при отправке сообщения:", err);
  }
}

// Команды
bot.start((ctx) => {
  users.add(ctx.from.id);
  saveUsers(); // сохраняем в файл
  ctx.reply("✅ Ты подписан на ежедневные уведомления!");
});

bot.command("id", (ctx) => {
  ctx.reply(`Твой Telegram ID: ${ctx.from.id}`);
  users.add(ctx.from.id);
});

// Отметка задач
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  if (!userTodos[chatId]) return;

  if (data.startsWith("toggle_")) {
    const index = parseInt(data.split("_")[1]);
    const todo = userTodos[chatId][index];
    todo.done = !todo.done;

    await setCellValue(todo.cell, todo.done ? "TRUE" : "FALSE");
    await ctx.editMessageReplyMarkup(getTodoKeyboard(chatId).reply_markup);
    await ctx.answerCbQuery();
  }
});

// Команда /today
bot.command("today", async (ctx) => {
  try {
    await ctx.sendChatAction("typing");
    const loadingMessage = await ctx.reply("⏳ Загружаю планы...");

    const curDate = new Date();
    const dateStr = curDate.toLocaleDateString("ru-RU", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    await sendDailyMessage(ctx.chat.id, loadingMessage, dateStr);

  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Ошибка при загрузке планов");
  }
});

// Авторассылка каждый день в 10:00
cron.schedule("0 09 * * *", () => {
  console.log("🕙 Запуск cron для отправки планов", [...users]);
  const curDate = new Date();
  const dateStr = curDate.toLocaleDateString("ru-RU", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  users.forEach((id) => sendDailyMessage(id, null, dateStr));
}, { timezone: "Europe/Moscow" });
// Запуск бота
bot.launch().then(() => console.log("🤖 Бот запущен!"));


