const { Telegraf, Markup } = require('telegraf');
const { registerUser } = require('./db');

/**
 * Create and configure the Telegraf bot.
 * @param {string} token - BOT_TOKEN
 * @returns {import('telegraf').Telegraf}
 */
function createBot(token) {
  const bot = new Telegraf(token);

  // /start — register user + send Mini App button
  bot.start(async (ctx) => {
    const { id, username, first_name } = ctx.from;

    // Register or update user in DB
    registerUser(id, username, first_name);

    const miniAppUrl = process.env.MINI_APP_URL;

    if (!miniAppUrl || miniAppUrl.includes('your-frontend-url')) {
      // Frontend not deployed yet — send plain welcome
      await ctx.reply(
        `Welcome, ${first_name || 'Player'}! ⚽\n\n` +
        `The Match Predictor app is not deployed yet.\n` +
        `Come back soon!`
      );
      return;
    }

    await ctx.reply(
      `Welcome, ${first_name || 'Player'}! ⚽\n\n` +
      `Predict match scores and climb the leaderboard.\n\n` +
      `Tap the button below to open the app:`,
      Markup.inlineKeyboard([
        Markup.button.webApp('🎯 Open Match Predictor', miniAppUrl),
      ])
    );
  });

  // Global error handler
  bot.catch((err, ctx) => {
    console.error(`[Bot] Error on ${ctx.updateType}:`, err.message);
  });

  return bot;
}

module.exports = { createBot };
