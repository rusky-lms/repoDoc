import asyncio
import asyncpg
import os
from dotenv import load_dotenv
load_dotenv('../.env')
async def main():
    url = os.environ.get("DATABASE_URL")
    print(f"URL: {url}")
    pool = await asyncpg.create_pool(url, ssl='require')
    async with pool.acquire() as conn:
        print("Connected!")
        await conn.execute("SELECT 1")
    await pool.close()
asyncio.run(main())
