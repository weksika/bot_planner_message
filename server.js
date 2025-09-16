import "dotenv/config";
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import cron from "node-cron";

const bot = new Telegraf(process.env.BOT_TOKEN);
const users = new Set();

// Хранилище дел пользователей
const userTodos = {};

// ======== Google Sheets ========
async function getCellValue(cell) {
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

async function setCellValue(cell, value) {
  try {
    const url = `${process.env.WEBAPP_URL}?cell=${cell}&value=${encodeURIComponent(value)}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.status === "ok";
  } catch (err) {
    console.error("Ошибка при записи в Google Sheets:", err);
    return false;
  }
}

// ======== Клавиатура ========
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

// ======== Дата и неделя ========
function editDate(date) {
  const weekday = date.getDay();
  switch (weekday) {
    case 1: return "D";
    case 2: return "J";
    case 3: return "P";
    case 4: return "V";
    case 5: return "AB";
    case 6: return "AH";
    case 0: return "AN";
    default: return "D";
  }
}

function func_week_number(date) {
  const day = date.getDate();
  const weekday = date.getDay();
  let week_number = 1;
  let vskr = weekday !== 0 && day - weekday > 0 ? day - weekday : day + weekday;
  for (let i = vskr; i > 7; i -= 7) week_number++;
  return week_number;
}

// ======== Загрузка и отправка задач ========
async function sendDailyMessage(chatId, loadingMessage = null, dateStr = null) {
  try {
    const curDate = new Date();
    const wn = func_week_number(curDate);
    const str = editDate(curDate);

    let charCode, numstr;
    if (str.length > 1) {
      charCode = str.charCodeAt(1);
      numstr = str[0] + String.fromCharCode(charCode - 1);
    } else {
      charCode = str.charCodeAt(0);
      numstr = String.fromCharCode(charCode - 1);
    }

    const numTasks = 8;

    // ======== Загружаем все задачи параллельно ========
    const taskPromises = [];
    for (let i = 1; i <= numTasks; i++) {
      const taskCell = `${str}${2 + 10 * wn + i}`;
      const checkCell = `${numstr}${2 + 10 * wn + i}`;
      taskPromises.push(
        Promise.all([getCellValue(taskCell), getCellValue(checkCell)])
          .then(([text, checkRaw]) => {
            if (!text) return null;
            return { text, done: checkRaw === true || checkRaw === "TRUE" || checkRaw === "1" };
          })
      );
    }

    const tasksArray = (await Promise.all(taskPromises)).filter(Boolean);

    if (tasksArray.length === 0) {
      if (loadingMessage) {
        await bot.telegram.editMessageText(
          chatId,
          loadingMessage.message_id,
          null,
          `📅 Планы на ${dateStr} отсутствуют.`
        );
      }
      return;
    }

    if (!userTodos[chatId]) userTodos[chatId] = tasksArray;

    const messageText = `📅 Планы на ${dateStr}:`;
    if (loadingMessage) {
      await bot.telegram.editMessageText(chatId, loadingMessage.message_id, null, messageText, getTodoKeyboard(chatId).reply_markup);
    } else {
      await bot.telegram.sendMessage(chatId, messageText, getTodoKeyboard(chatId));
    }

    console.log(`✅ Планы отправлены пользователю ${chatId}`);
  } catch (err) {
    console.error("Ошибка при отправке задач:", err);
  }
}

// ======== Команды бота ========
bot.start((ctx) => {
  ctx.reply("Привет! Я буду отправлять уведомления о планах.");
  users.add(ctx.from.id);
});

bot.command("id", (ctx) => {
  ctx.reply(`Твой Telegram ID: ${ctx.from.id}`);
  users.add(ctx.from.id);
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

// ======== Обработка чекбоксов ========
bot.on("callback_query", async (ctx) => {
  const chatId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  if (!userTodos[chatId]) return;

  if (data.startsWith("toggle_")) {
    const index = parseInt(data.split("_")[1]);
    const todo = userTodos[chatId][index];

    const curDate = new Date();
    const wn = func_week_number(curDate);
    const str = editDate(curDate);
    let charCode, numstr;
    if (str.length > 1) {
      charCode = str.charCodeAt(1);
      numstr = str[0] + String.fromCharCode(charCode - 1);
    } else {
      charCode = str.charCodeAt(0);
      numstr = String.fromCharCode(charCode - 1);
    }

    const row = 2 + 10 * wn + index + 1;

    todo.done = !todo.done;

    const checkCell = `${numstr}${row}`;
    await setCellValue(checkCell, todo.done ? "TRUE" : "FALSE");

    await ctx.editMessageReplyMarkup(getTodoKeyboard(chatId).reply_markup);
    await ctx.answerCbQuery();
  }
});

// ======== Запуск бота ========
bot.launch().then(() => console.log("🤖 Бот запущен!"));

// ======== Cron для ежедневной отправки ========
cron.schedule("0 10 * * *", () => {
  console.log("Отправляем ежедневное сообщение по cron...");
  users.forEach((id) => sendDailyMessage(id));
});
