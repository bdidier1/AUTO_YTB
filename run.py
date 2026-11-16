"""Lance AUTO YTB en local et ouvre le navigateur."""
import asyncio
import threading
import webbrowser

import uvicorn

from app.config import BASE_URL, HOST, PORT


def _quiet_disconnects(loop, context):
    # Windows : quand le navigateur ferme une connexion (ex. on avance dans une video),
    # asyncio affiche un faux « ConnectionResetError [WinError 10054] ». Sans gravite : on l'ignore.
    if isinstance(context.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
        return
    loop.default_exception_handler(context)


async def main():
    asyncio.get_running_loop().set_exception_handler(_quiet_disconnects)
    config = uvicorn.Config("app.server:app", host=HOST, port=PORT, log_level="warning", proxy_headers=False)
    await uvicorn.Server(config).serve()


if __name__ == "__main__":
    threading.Timer(1.5, lambda: webbrowser.open(BASE_URL)).start()
    print(f"\n  AUTO YTB -> {BASE_URL}   (ferme cette fenetre pour arreter)\n")
    asyncio.run(main())
