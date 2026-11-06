"""
PUENTE TIKTOK -> PANEL  (Il Mondo dei Bambino)
------------------------------------------------
Este programa corre en tu laptop durante el live.
1) Escucha el live de TikTok (como un espectador más, sin contraseña).
2) Le pasa cada comentario a panel.html por  ws://localhost:8765

Cómo usarlo:
    python puente_tiktok.py            -> modo normal (el panel le dice qué cuenta escuchar)
    python puente_tiktok.py --demo     -> comentarios de prueba, sin TikTok

Clave de Euler Stream (OPCIONAL, solo sube los límites):
    crea un archivo  clave_euler.txt  al lado de este programa y pega la clave adentro.

Para cerrarlo: Ctrl + C
"""
import asyncio
import json
import random
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs

try:
    from websockets.asyncio.server import serve
except ImportError:
    print("Falta instalar las librerías. Ejecuta:  python -m pip install TikTokLive websockets")
    sys.exit(1)

PUERTO = 8765
DEMO = "--demo" in sys.argv
paneles = set()          # paneles (pestañas) conectados
escucha = {"cuenta": None, "cliente": None, "tarea": None}


def hora():
    return datetime.now().strftime("%H:%M:%S")


def log(t):
    print(f"[{hora()}] {t}", flush=True)


async def enviar(msg: dict):
    """Manda un mensaje a todos los paneles abiertos."""
    texto = json.dumps(msg, ensure_ascii=False)
    for ws in list(paneles):
        try:
            await ws.send(texto)
        except Exception:
            paneles.discard(ws)


async def estado(texto, nivel="info"):
    log(texto)
    await enviar({"type": "estado", "nivel": nivel, "texto": texto})


async def comentario(usuario, nombre, texto):
    log(f"💬 {nombre} (@{usuario}): {texto}")
    await enviar({"type": "chat", "user": {"uniqueId": usuario, "nickname": nombre}, "comment": texto})


# ------------------------------------------------------------------ DEMO
EJEMPLOS = [
    ("mami_lucia", "Lucía", "Hola buenas noches 🌸"), ("anita.t", "Ana Torres", "cuánto el A3?"),
    ("kari_ec", "Karina", "tiene otro modelo en rosado?"), ("anita.t", "Ana Torres", "separo A3 talla 0-3"),
    ("rosi_m", "Rosi", "la quiero! A4 en 3-6 meses"), ("kari_ec", "Karina", "me lo llevo A5, mi número 099 123 4567"),
    ("vale.ec", "Valeria", "mía la A8"), ("dany_88", "Dany", "qué más tienen de niño?"),
]


async def escuchar_demo(cuenta):
    await estado(f"🧪 DEMO conectado (simulando @{cuenta})", "ok")
    while True:
        await asyncio.sleep(random.uniform(1.0, 2.5))
        await comentario(*random.choice(EJEMPLOS))


# ------------------------------------------------------------------ TIKTOK REAL
async def escuchar_tiktok(cuenta):
    from TikTokLive import TikTokLiveClient
    from TikTokLive.events import CommentEvent, ConnectEvent, DisconnectEvent, LiveEndEvent

    clave = Path(__file__).with_name("clave_euler.txt")
    if clave.exists() and clave.read_text(encoding="utf-8").strip():
        from TikTokLive.client.web.web_settings import WebDefaults
        WebDefaults.tiktok_sign_api_key = clave.read_text(encoding="utf-8").strip()
        log("Usando tu clave de Euler Stream (clave_euler.txt)")

    cliente = TikTokLiveClient(unique_id=cuenta)
    escucha["cliente"] = cliente

    @cliente.on(ConnectEvent)
    async def al_conectar(e):
        await estado(f"🔴 Conectado al live de @{cuenta}. Esperando comentarios…", "ok")

    @cliente.on(CommentEvent)
    async def al_comentar(e: CommentEvent):
        u = e.user
        usuario = getattr(u, "unique_id", "") or getattr(u, "uniqueId", "") or ""
        nombre = getattr(u, "nickname", "") or usuario
        await comentario(usuario, nombre, e.comment or "")

    @cliente.on(LiveEndEvent)
    async def al_terminar(e):
        await estado("El live terminó.", "fin")

    @cliente.on(DisconnectEvent)
    async def al_desconectar(e):
        await estado("Se desconectó de TikTok.", "fin")

    await estado(f"Conectando a @{cuenta}…")
    try:
        await cliente.connect()            # se queda aquí hasta que termine el live
    except Exception as err:
        nombre = type(err).__name__
        if nombre == "UserOfflineError":
            await estado(f"@{cuenta} no está en vivo ahora. Conecta cuando ya esté transmitiendo.", "error")
        elif nombre == "UserNotFoundError":
            await estado(f"No existe la cuenta @{cuenta}. Revisa cómo está escrita.", "error")
        elif "RateLimit" in nombre:
            await estado("Se pasó el límite gratis de conexiones. Espera unos minutos o pon una clave en clave_euler.txt.", "error")
        elif nombre == "AgeRestrictedError":
            await estado("Ese live es solo para mayores de 18 y no se puede leer sin iniciar sesión.", "error")
        else:
            await estado(f"No se pudo conectar ({nombre}): {err}", "error")


async def empezar(cuenta):
    """Empieza a escuchar una cuenta (si ya escuchaba esa misma, no hace nada)."""
    if escucha["cuenta"] == cuenta and escucha["tarea"] and not escucha["tarea"].done():
        await estado(f"Ya estoy escuchando a @{cuenta}.", "ok")
        return
    await parar()
    escucha["cuenta"] = cuenta
    escucha["tarea"] = asyncio.create_task(escuchar_demo(cuenta) if DEMO else escuchar_tiktok(cuenta))


async def parar():
    cli, tarea = escucha["cliente"], escucha["tarea"]
    escucha.update(cuenta=None, cliente=None, tarea=None)
    if cli:
        try:
            await cli.disconnect()
        except Exception:
            pass
    if tarea and not tarea.done():
        tarea.cancel()


# ------------------------------------------------------------------ SERVIDOR PARA EL PANEL
async def atender_panel(ws):
    paneles.add(ws)
    q = parse_qs(urlparse(ws.request.path).query)
    cuenta = (q.get("uniqueId", [""])[0] or "").strip().lstrip("@")
    log(f"Se abrió el panel ({len(paneles)} abierto/s)")
    try:
        if cuenta:
            await empezar(cuenta)
        else:
            await estado("El panel no mandó la cuenta de TikTok.", "error")
        async for _ in ws:      # el panel no manda nada; solo esperamos a que se cierre
            pass
    finally:
        paneles.discard(ws)
        log(f"Se cerró el panel ({len(paneles)} abierto/s)")
        if not paneles:
            await parar()
            log("Nadie mira el panel: dejé de escuchar el live.")


async def main():
    print("=" * 56)
    print("  PUENTE TIKTOK -> PANEL  ·  Il Mondo dei Bambino")
    print("=" * 56)
    print("  Modo:", "DEMO (comentarios de prueba)" if DEMO else "TikTok en vivo")
    print(f"  Escuchando al panel en  ws://localhost:{PUERTO}")
    print("  Ahora abre panel.html → 💬 Comentarios → Conectar")
    print("  Deja esta ventana ABIERTA durante el live. Ctrl+C para cerrar.")
    print("=" * 56, flush=True)
    async with serve(atender_panel, "localhost", PUERTO):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nPuente cerrado. ¡Buen live!")
    except OSError as e:
        print(f"\nNo pude abrir el puerto {PUERTO}. ¿Ya hay otro puente abierto? ({e})")
