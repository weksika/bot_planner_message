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

const userTodos = {};
loadUsers();
console.log("Загружены пользователи:", [...users]);

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
    const url = `${process.env.WEBAPP_URL}?cell=${cell}&value=${value}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.status === "ok";
  } catch (err) {
    console.error("Ошибка при записи в Google Sheets:", err);
    return false;
  }
}

// Получение привычек для дня
async function getHabitsForToday() {
  const weekday = new Date().getDay(); // 0 - вс, 1 - пн
  const dayColMap = ["P","J","K","L","M","N","O"]; // 0=Вс->P, 1=Пн->J
  const dayCol = dayColMap[weekday];

  const habits = [];
  for (let i = 0; i < 5; i++) { // 5 привычек
    const nameCell = `C${4 + i}`; // C4:I4, берем C
    const timeCell = `${String.fromCharCode(dayCol.charCodeAt(0))}${4 + i}`; // J4, K4...
    const habitName = await getCellValue(nameCell);
    const habitTime = await getCellValue(dayCol + (4 + i));
    habits.push({ name: habitName, time: habitTime, row: 4 + i });
  }
  return habits;
}

async function sendMorningHabits(chatId) {
  const habits = await getHabitsForToday();
  let text = "☀️ Привычки на сегодня:\n";
  habits.forEach(h => {
    text += `- ${h.name} в ${h.time || "не указано"}\n`;
  });
  await bot.telegram.sendMessage(chatId, text);
}

// Авторассылка утром всем
cron.schedule("0 8 * * *", () => {
  console.log("☀️ Отправка утренних привычек");
  users.forEach(id => sendMorningHabits(id));
}, { timezone: "Europe/Moscow" });

// Отправка уведомления за 10 минут до времени привычки
async function scheduleHabitReminders() {
  const habits = await getHabitsForToday();
  habits.forEach(h => {
    if (!h.time) return;
    const [hour, minute] = h.time.split(":").map(Number);
    const date = new Date();
    date.setHours(hour);
    date.setMinutes(minute - 10); // за 10 минут
    date.setSeconds(0);

    const now = new Date();
    const delay = date.getTime() - now.getTime();
    if (delay > 0) {
      setTimeout(() => {
        users.forEach(id => {
          bot.telegram.sendMessage(id, `⏰ Напоминание: ${h.name} через 10 минут`);
        });
      }, delay);
    }
  });
}

// Запускаем проверку напоминаний каждые 10 минут
cron.schedule("*/10 * * * *", scheduleHabitReminders, { timezone: "Europe/Moscow" });

// Команды
bot.start(ctx => {
  users.add(ctx.from.id);
  saveUsers();
  ctx.reply("✅ Ты подписан на уведомления о привычках!");
});

bot.command("habits", async ctx => {
  await sendMorningHabits(ctx.chat.id);
});

// Запуск бота
bot.launch().then(() => console.log("🤖 Бот запущен!"));


