// Placeholder until the landing page is built: send people to the bot.
import { shell } from "../ui.js";
import { telegramButton } from "./common.js";
const main = shell("Post-quantum wallet alerts for QoreChain");
main.innerHTML = `<p class="eyebrow">QoreWatch</p><h1>Post-quantum wallet alerts for QoreChain.</h1><p class="lead">A Telegram bot that tells you the moment money moves, your post-quantum key changes, a spending window opens or someone gets permission to spend for you.</p>${telegramButton("Open @qorewatchbot")}`;
