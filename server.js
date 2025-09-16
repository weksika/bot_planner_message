import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const users = new Set();
const userTodos = {};

// Получение значения ячейки
async function getCellValue(cell) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.value;
  } catch (err) {
    console.error("Ошибка при получении данных:", err);
    return null;
  }
}

// Установка значения ячейки
async function setCellValue(cell, value) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}&value=${value}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.status === "ok";
  } catch (err) {
    console.error("Ошибка при записи:", err);
    return false;
  }
}

// Генерация клавиатуры
function getTodoKeyboard(userId) {
  const todos = userTodos[userId] || [];
  return {
    inline_keyboard: [
      ...todos.map((t, i) => [
        { text: `${t.done ? "✅" : "☑️"} ${t.text}`, callback_data: `toggle_${i}` },
      ]),
      [{ text: "Готово", callback_data: "done" }],
    ],
  };
}

// Определяем колонку по дню недели
function editDate(date) {
  switch (date.getDay()) {
    case 1: return "D";
    case 2: return "J";
    case 3: return "P";
    case 4: return "V";
    case 5: return "AB";
    case 6: return "AH";
    case 0: return "AN";
  }
}

// Номер недели
function func_week_number(date){
  const day = date.getDate();
  const weekday = date.getDay();
  let week_number = 1;
  let vskr = (day - weekday > 0 && weekday != 0) ? day - weekday : day + weekday;
  for (let i = vskr; i > 7; i -= 7) week_number++;
  return week_number;
}

// Отправка планов
async function sendDailyMessage(chatId) {
  const curDate = new Date();
  const dateStr = curDate.toLocaleDateString("ru-RU", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
  const wn = func_week_number(curDate);
  const str = editDate(curDate);
  const numstr = str.length > 1 ? str[0] + String.fromCharCode(str.charCodeAt(1)-1) : String.fromCharCode(str.charCodeAt(0)-1);
  
  const userTasks = {};
  const numTasks = 8;

  for (let i = 1; i <= numTasks; i++) {
    const taskCell = `${str}${(2 + (10*wn)) + i}`;
    const checkCell = `${numstr}${(2 + (10*wn)) + i}`;
    const taskText = await getCellValue(taskCell);
    if (!taskText) continue;
    const taskCheckRaw = await getCellValue(checkCell);
    const taskDone = taskCheckRaw === true || taskCheckRaw === "TRUE" || taskCheckRaw === "1";
    userTasks[`task${i}`] = { text: taskText, done: taskDone, cell: checkCell };
  }

  const tasksArray = Object.values(userTasks);
  if (tasksArray.length === 0) {
    await bot.telegram.sendMessage(chatId, `📅 Планы на ${dateStr} отсутствуют.`);
    return;
  }

  userTodos[chatId] = tasksArray;
  await bot.telegram.sendMessage(chatId, `📅 Планы на ${dateStr}:`, { reply_markup: getTodoKeyboard(chatId) });
}

// Обработка нажатий по кнопкам
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  if (!userTodos[chatId]) return;

  if (data.startsWith("toggle_")) {
    const index = parseInt(data.split("_")[1]);
    const todo = userTodos[chatId][index];
    todo.done = !todo.done;

    // Обновляем таблицу
    await setCellValue(todo.cell, todo.done ? "TRUE" : "FALSE");

    // Обновляем клавиатуру
    await ctx.editMessageReplyMarkup({ inline_keyboard: getTodoKeyboard(chatId).inline_keyboard });
    await ctx.answerCbQuery();
  }
});

// Команды
bot.start((ctx) => {
  ctx.reply("Привет! Я буду отправлять ежедневные уведомления.");
  users.add(ctx.from.id);
});

bot.command("today", async (ctx) => {
  try {
    await ctx.sendChatAction("typing");
    await sendDailyMessage(ctx.chat.id);
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Ошибка при загрузке планов");
  }
});

// Планировщик каждый день в 10:00
cron.schedule("0 10 * * *", () => {
  users.forEach(id => sendDailyMessage(id));
});

bot.launch().then(() => console.log("🤖 Бот запущен!"));

