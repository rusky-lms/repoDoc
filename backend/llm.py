import litellm
import logging
logger = logging.getLogger(__name__)
class UserMessage:
    def __init__(self, text: str):
        self.text = text
class LlmChat:
    def __init__(self, api_key: str, session_id: str = None, system_message: str = None):
        self.api_key = api_key
        self.system_message = system_message
        self.model = "gemini/gemini-1.5-flash" # Default
    def with_model(self, provider: str, model: str):
        if provider == "gemini":
            self.model = f"gemini/{model}"
        elif provider == "openai":
            self.model = model
        return self
    async def send_message(self, message: UserMessage) -> str:
        messages = []
        if self.system_message:
            messages.append({"role": "system", "content": self.system_message})
        messages.append({"role": "user", "content": message.text})
        try:
            response = await litellm.acompletion(
                model=self.model,
                messages=messages,
                api_key=self.api_key
            )
            return response.choices[0].message.content
        except Exception as e:
            logger.error(f"LLM Error: {e}")
            raise
