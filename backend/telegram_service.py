import httpx
import asyncio
import logging

logger = logging.getLogger(__name__)


class TelegramService:
    def __init__(self, token: str):
        self.token = token
        self.base_url = f"https://api.telegram.org/bot{token}"
        self._running = False

    async def send_message(self, chat_id: str, text: str):
        if not self.token or not chat_id:
            return
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post(
                    f"{self.base_url}/sendMessage",
                    json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
                )
        except Exception as e:
            logger.warning(f"Telegram send_message failed: {e}")

    async def get_updates(self, offset: int = 0):
        try:
            async with httpx.AsyncClient(timeout=35) as client:
                resp = await client.get(
                    f"{self.base_url}/getUpdates",
                    params={"offset": offset, "timeout": 25, "allowed_updates": ["message"]},
                )
                data = resp.json()
                return data.get("result", [])
        except Exception as e:
            logger.warning(f"Telegram get_updates failed: {e}")
            return []

    async def start_polling(self, db, trigger_analysis_fn):
        self._running = True
        offset = 0
        logger.info("Telegram bot polling started")
        while self._running:
            try:
                updates = await self.get_updates(offset)
                for update in updates:
                    offset = update["update_id"] + 1
                    message = update.get("message", {})
                    text = message.get("text", "")
                    chat_id = str(message.get("chat", {}).get("id", ""))
                    if text.startswith("/analyze "):
                        repo_url = text[9:].strip()
                        if repo_url:
                            await self.send_message(chat_id, f"<b>RepoDoctor</b> starting analysis...\n\n<code>{repo_url}</code>")
                            asyncio.create_task(trigger_analysis_fn(repo_url, chat_id))
                    elif text == "/start" or text == "/help":
                        await self.send_message(
                            chat_id,
                            "<b>RepoDoctor Bot</b>\n\nI find and fix bugs in GitHub repos autonomously.\n\nUsage:\n<code>/analyze https://github.com/user/repo</code>"
                        )
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"Telegram polling error: {e}")
                await asyncio.sleep(5)

    def stop(self):
        self._running = False
