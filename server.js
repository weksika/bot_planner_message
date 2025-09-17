import fs from "fs";
import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const users = new Set();
const userTodos = {};   // старые планы
const userHabits = {};  // новые привычки

// ======================
// Пользователи
// ======================
function saveUsers() { fs.writeFileSync("users.json", JSON.stringify([...users], null, 2)); }

function loadUsers() {
  if (fs.existsSync("users.json")) {
    const data = JSON.parse(fs.readFileSync("users.json"));
    data.forEach(id => users.add(id));
  }
}
loadUsers();
console.log("Загружены пользователи:", [...users]);

// ======================
// Google Sheets
// ======================
export async function getCellValue(cell) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.value;
  } catch (err) {
    console.error("Ошибка при получении данных из Google Sheets:", err);
    return null;
  }
}

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

// ======================
// Планы (твоя старая логика)
// ======================
function getTodoKeyboard(userId) {
  const todos = userTodos[userId] || [];
  return {
    reply_markup: {
      inline_keyboard: todos.map((t, i) => [{ text: `${t.done ? "✅" : "☑️"} ${t.text}`, callback_data: `toggle_${i}` }])
    }
  };
}

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

async function sendDailyMessage(chatId, loadingMessage = null, dateStr = null) {
  let curDate = new Date();
  let wn = func_week_number(curDate);
  let str = editDate(curDate);

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
      await bot.telegram.editMessageText(chatId, loadingMessage.message_id, undefined, `📅 Планы на ${dateStr} отсутствуют.`);
    }
    return;
  }

  if (!userTodos[chatId]) userTodos[chatId] = tasksArray;

  const messageText = `📅 Планы на ${dateStr}:`;

  try {
    if (loadingMessage) {
      await bot.telegram.editMessageText(chatId, loadingMessage.message_id, undefined, messageText, { reply_markup: getTodoKeyboard(chatId).reply_markup });
    } else {
      await bot.telegram.sendMessage(chatId, messageText, getTodoKeyboard(chatId));
    }
  } catch (err) {
    console.error("Ошибка при отправке сообщения:", err);
  }
}

// ======================
// Привычки (новый функционал)
// ======================
function getHabitsKeyboard(userId) {
  const habits = userHabits[userId] || [];
  return {
    reply_markup: {
      inline_keyboard: habits.map((h, i) => [{ text: `${h.done ? "✅" : "☑️"} ${h.name}`, callback_data: `habit_toggle_${i}` }])
    }
  };
}

async function loadHabitsForUser(userId) {
  const weekday = new Date().getDay(); // 0-вс, 1-пн, ...
  const habitsList = [];
  for (let i = 4; i <= 8; i++) { // строки привычек 4-8
    const habitNameCell = `C${i}:I${i}`;
    const habitName = await getCellValue(`C${i}`); // берем только C как название
    if (!habitName) continue;

    const dayColumn = String.fromCharCode(74 + weekday - 1); // J=74, K=75 ...
    const habitTime = await getCellValue(`${dayColumn}${i}`); 
    habitsList.push({ name: habitName, time: habitTime, done: false, row: i });
  }
  userHabits[userId] = habitsList;
}

async function sendMorningHabits(userId) {
  await loadHabitsForUser(userId);
  const habits = userHabits[userId];
  if (!habits || habits.length === 0) return;

  const message = "🌞 Утренние привычки:\n" + habits.map(h => `- ${h.name} (${h.time || "время не задано"})`).join("\n");
  await bot.telegram.sendMessage(userId, message, getHabitsKeyboard(userId));
}

async function sendHabitReminder(userId, habit) {
  await bot.telegram.sendMessage(userId, `⏰ Через 10 минут: ${habit.name}`, getHabitsKeyboard(userId));
}

// проверка привычек каждую минуту
setInterval(async () => {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  for (const userId of users) {
    if (!userHabits[userId]) await loadHabitsForUser(userId);
    const habits = userHabits[userId];
    if (!habits) continue;

    for (const habit of habits) {
      if (!habit.time) continue;
      const [h, m] = habit.time.split(":").map(Number);
      const habitMinutes = h * 60 + m;
      if (habitMinutes - 10 === nowMinutes) {
        await sendHabitReminder(userId, habit);
      }
    }
  }
}, 60000);

// ======================
// Команды бота
// ======================
bot.start((ctx) => { users.add(ctx.from.id); saveUsers(); ctx.reply("✅ Ты подписан на ежедневные уведомления!"); });
bot.command("id", (ctx) => { ctx.reply(`Твой Telegram ID: ${ctx.from.id}`); users.add(ctx.from.id); });
bot.command("today", async (ctx) => {
  try {
    await ctx.sendChatAction("typing");
    const loadingMessage = await ctx.reply("⏳ Загружаю планы...");
    const curDate = new Date();
    const dateStr = curDate.toLocaleDateString("ru-RU", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    await sendDailyMessage(ctx.chat.id, loadingMessage, dateStr);
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Ошибка при загрузке планов");
  }
});
bot.command("habits", async (ctx) => { await sendMorningHabits(ctx.from.id); });

bot.on("callback_query", async (ctx) => {
  const chatId = ctx.from.id;
  const data = ctx.callbackQuery.data;

  // план
  if (data.startsWith("toggle_")) {
    const index = parseInt(data.split("_")[1]);
    const todo = userTodos[chatId][index];
    todo.done = !todo.done;
    await setCellValue(todo.cell, todo.done ? "TRUE" : "FALSE");
    await ctx.editMessageReplyMarkup(getTodoKeyboard(chatId).reply_markup);
    await ctx.answerCbQuery();
  }

  // привычка
  if (data.startsWith("habit_toggle_")) {
    const index = parseInt(data.split("_")[2]);
    const habit = userHabits[chatId][index];
    habit.done = !habit.done;
    await ctx.editMessageReplyMarkup(getHabitsKeyboard(chatId).reply_markup);
    await ctx.answerCbQuery();
  }
});

// ======================
// Авторассылка планов
// ======================
cron.schedule("0 09 * * *", () => {
  const curDate = new Date();
  const dateStr = curDate.toLocaleDateString("ru-RU", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  users.forEach((id) => sendDailyMessage(id, null, dateStr));
}, { timezone: "Europe/Moscow" });

// ======================
// Запуск бота
// ======================
bot.launch().then(() => console.log("🤖 Бот запущен!"));