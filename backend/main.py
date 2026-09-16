import asyncio
import logging
import os
import re
import secrets
import string
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import quote

import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

from telegram import (
    Update,
    ReplyKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardRemove,
)

from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

# Load a local .env file if present (no-op on Render, which injects
# environment variables natively). Safe to leave in for both environments.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


# ============================================================
# HERITAGE PIN
# ============================================================
#
# Backend:
#
# Telegram Bot
#       |
#       v
#     main.py
#       |
#       +---- Firebase Authentication
#       |
#       +---- Firebase Realtime Database
#       |
#       +---- Flask REST API
#                   |
#                   v
#              Netlify / Vercel
#
# Firebase Storage = NOT USED
#
# Render URL = NOT USED IN THIS FILE
#
# ============================================================


# ============================================================
# LOGGING
# ============================================================

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)

logger = logging.getLogger("heritage-pin")


# ============================================================
# TELEGRAM BOT
# ============================================================
#
# Set these as environment variables (locally in a .env file,
# on Render in the service's Environment tab). Never hardcode
# real values here.
#
# ============================================================

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")

BOT_USERNAME = os.environ.get("BOT_USERNAME", "HeritagePinDemoBot")


# ============================================================
# FIREBASE WEB CONFIG
# ============================================================
#
# All values below come from environment variables. Set them
# in Render's dashboard (Environment tab) and/or a local .env
# file (gitignored) for development.
#
# ============================================================

FIREBASE_API_KEY = os.environ.get("FIREBASE_API_KEY", "")

FIREBASE_AUTH_DOMAIN = os.environ.get("FIREBASE_AUTH_DOMAIN", "")

FIREBASE_DATABASE_URL = os.environ.get("FIREBASE_DATABASE_URL", "")

FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "")

FIREBASE_STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET", "")

FIREBASE_MESSAGING_SENDER_ID = os.environ.get(
    "FIREBASE_MESSAGING_SENDER_ID", ""
)

FIREBASE_APP_ID = os.environ.get("FIREBASE_APP_ID", "")

FIREBASE_MEASUREMENT_ID = os.environ.get("FIREBASE_MEASUREMENT_ID", "")


# ============================================================
# RENDER PORT
# ============================================================

PORT = int(os.environ.get("PORT", "10000"))


# ============================================================
# FIREBASE AUTH REST ENDPOINTS
# ============================================================

FIREBASE_SIGNUP_URL = (
    "https://identitytoolkit.googleapis.com/v1/"
    f"accounts:signUp?key={FIREBASE_API_KEY}"
)

FIREBASE_SIGNIN_URL = (
    "https://identitytoolkit.googleapis.com/v1/"
    f"accounts:signInWithPassword?key={FIREBASE_API_KEY}"
)

FIREBASE_LOOKUP_URL = (
    "https://identitytoolkit.googleapis.com/v1/"
    f"accounts:lookup?key={FIREBASE_API_KEY}"
)


# ============================================================
# CONVERSATION STATES
# ============================================================

NAME, CRAFT, LOCATION, VIDEO, VOICE = range(5)


# ============================================================
# CLAIM RATE LIMIT
# ============================================================

claim_attempts: Dict[str, float] = {}


# ============================================================
# HELPERS
# ============================================================

def clean_text(
    value: Any,
    max_length: int = 100,
) -> str:

    return str(
        value or ""
    ).strip()[:max_length]


def valid_pin_id(
    pin_id: str,
) -> bool:

    return bool(
        re.fullmatch(
            r"HP-[A-Z0-9]{6}",
            pin_id,
        )
    )


def valid_coordinates(
    latitude: float,
    longitude: float,
) -> bool:

    return (
        -90 <= latitude <= 90
        and
        -180 <= longitude <= 180
    )


# ============================================================
# GEOFENCE
# ============================================================

def verify_geofence(
    latitude: float,
    longitude: float,
) -> tuple[bool, str]:

    # Broad India pilot boundary.
    if (
        8.0 <= latitude <= 37.0
        and
        68.0 <= longitude <= 97.0
    ):
        return (
            True,
            "Location verified inside the supported India pilot boundary.",
        )

    return (
        False,
        "Location is outside the supported Heritage Pin pilot boundary.",
    )


# ============================================================
# AI / NVIDIA NIM DEMO
# ============================================================

def process_nvidia_nim_asr(
    voice_file_id: str,
) -> dict:

    """
    DEMO AI FUNCTION.

    Replace this function with the real NVIDIA NIM
    request when your NIM API is ready.
    """

    return {
        "raw_transcript": (
            "नमस्ते, मैं एक पारंपरिक कलाकार हूं जो "
            "प्रामाणिक हथकरघा साड़ियां बनाता हूं।"
        ),

        "translated_text": (
            "Hello, I am a traditional custodian crafting "
            "authentic handloom sarees."
        ),

        "detected_language": "Hindi",

        "confidence_score": 0.98,
    }


# ============================================================
# HERITAGE ID
# ============================================================

def generate_pin_id() -> str:

    alphabet = (
        string.ascii_uppercase
        + string.digits
    )

    while True:

        suffix = "".join(
            secrets.choice(alphabet)
            for _ in range(6)
        )

        return f"HP-{suffix}"


# ============================================================
# PASSWORD
# ============================================================

def generate_password(
    length: int = 10,
) -> str:

    alphabet = (
        string.ascii_letters
        + string.digits
    )

    while True:

        password = "".join(
            secrets.choice(alphabet)
            for _ in range(length)
        )

        if (
            any(c.isupper() for c in password)
            and
            any(c.islower() for c in password)
            and
            any(c.isdigit() for c in password)
        ):

            return password


# ============================================================
# FIREBASE ERROR
# ============================================================

def firebase_error_message(
    response: requests.Response,
) -> str:

    try:

        payload = response.json()

        error = payload.get(
            "error",
            {},
        )

        message = error.get(
            "message",
            "",
        )

        if message:
            return str(message)

    except Exception:
        pass

    return (
        f"Firebase request failed "
        f"({response.status_code})."
    )


# ============================================================
# FIREBASE AUTH
# ============================================================

def firebase_create_user(
    email: str,
    password: str,
) -> Dict[str, Any]:

    response = requests.post(
        FIREBASE_SIGNUP_URL,

        json={
            "email": email,
            "password": password,
            "returnSecureToken": True,
        },

        timeout=20,
    )

    if not response.ok:

        raise RuntimeError(
            firebase_error_message(
                response
            )
        )

    return response.json()


def firebase_sign_in(
    email: str,
    password: str,
) -> Dict[str, Any]:

    response = requests.post(
        FIREBASE_SIGNIN_URL,

        json={
            "email": email,
            "password": password,
            "returnSecureToken": True,
        },

        timeout=20,
    )

    if not response.ok:

        raise RuntimeError(
            firebase_error_message(
                response
            )
        )

    return response.json()


def firebase_lookup_token(
    id_token: str,
) -> Dict[str, Any]:

    response = requests.post(
        FIREBASE_LOOKUP_URL,

        json={
            "idToken": id_token,
        },

        timeout=20,
    )

    if not response.ok:

        raise RuntimeError(
            firebase_error_message(
                response
            )
        )

    data = response.json()

    users = data.get(
        "users",
        [],
    )

    if not users:

        raise RuntimeError(
            "Firebase user was not found."
        )

    return users[0]


# ============================================================
# FIREBASE REALTIME DATABASE
# ============================================================

def firebase_get(
    path: str,
) -> Any:

    url = (
        f"{FIREBASE_DATABASE_URL}/"
        f"{path.lstrip('/')}.json"
    )

    response = requests.get(
        url,
        timeout=20,
    )

    if not response.ok:

        raise RuntimeError(
            firebase_error_message(
                response
            )
        )

    return response.json()


def firebase_put(
    path: str,
    data: Any,
    id_token: Optional[str] = None,
) -> Any:

    url = (
        f"{FIREBASE_DATABASE_URL}/"
        f"{path.lstrip('/')}.json"
    )

    if id_token:

        url += (
            "?auth="
            + quote(
                id_token,
                safe="",
            )
        )

    response = requests.put(
        url,
        json=data,
        timeout=20,
    )

    if not response.ok:

        raise RuntimeError(
            firebase_error_message(
                response
            )
        )

    return response.json()


def firebase_patch(
    path: str,
    data: Dict[str, Any],
    id_token: Optional[str] = None,
) -> Any:

    url = (
        f"{FIREBASE_DATABASE_URL}/"
        f"{path.lstrip('/')}.json"
    )

    if id_token:

        url += (
            "?auth="
            + quote(
                id_token,
                safe="",
            )
        )

    response = requests.patch(
        url,
        json=data,
        timeout=20,
    )

    if not response.ok:

        raise RuntimeError(
            firebase_error_message(
                response
            )
        )

    return response.json()


# ============================================================
# INTERNAL FIREBASE EMAIL
# ============================================================

def firebase_email_for_pin(
    pin_id: str,
) -> str:

    return (
        f"{pin_id.lower()}"
        "@heritagepin.app"
    )


# ============================================================
# PUBLIC PIN
# ============================================================

def public_pin(
    record: Dict[str, Any],
) -> Dict[str, Any]:

    result = dict(record)

    private_fields = [
        "owner_uid",
        "auth_email",
        "telegram_user_id",
        "credential_created_at",
    ]

    for field in private_fields:

        result.pop(
            field,
            None,
        )

    return result


# ============================================================
# TELEGRAM /START
# ============================================================

async def start(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> int:

    user = update.effective_user

    context.user_data.clear()

    context.user_data[
        "telegram_user_id"
    ] = user.id

    await update.message.reply_text(

        f"🙏 Welcome to *Heritage Pin*, "
        f"{user.first_name or 'Custodian'}!\n\n"

        "*Culture, on its own terms.*\n\n"

        "I will help create a Heritage Pin "
        "for your traditional craft.\n\n"

        "*Step 1/5 — Your Name*\n"
        "What is your public name or "
        "collective name?",

        parse_mode="Markdown",
    )

    return NAME


# ============================================================
# NAME
# ============================================================

async def handle_name(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> int:

    name = clean_text(
        update.message.text,
        100,
    )

    if not name:

        await update.message.reply_text(
            "Please enter your public name."
        )

        return NAME

    context.user_data[
        "name"
    ] = name

    await update.message.reply_text(

        "*Step 2/5 — Craft*\n\n"

        "What craft or traditional practice "
        "do you work in?",

        parse_mode="Markdown",
    )

    return CRAFT


# ============================================================
# CRAFT
# ============================================================

async def handle_craft(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> int:

    craft = clean_text(
        update.message.text,
        100,
    )

    if not craft:

        await update.message.reply_text(
            "Please enter the name of your craft."
        )

        return CRAFT

    context.user_data[
        "craft"
    ] = craft

    location_button = KeyboardButton(
        text="📍 Share Current Location",
        request_location=True,
    )

    keyboard = ReplyKeyboardMarkup(
        [
            [location_button]
        ],

        resize_keyboard=True,

        one_time_keyboard=True,
    )

    await update.message.reply_text(

        "*Step 3/5 — Location*\n\n"

        "Share the location where your "
        "craft is based.",

        reply_markup=keyboard,

        parse_mode="Markdown",
    )

    return LOCATION


# ============================================================
# LOCATION
# ============================================================

async def handle_location(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> int:

    if not update.message.location:

        await update.message.reply_text(
            "Please use the location button."
        )

        return LOCATION

    latitude = float(
        update.message.location.latitude
    )

    longitude = float(
        update.message.location.longitude
    )

    if not valid_coordinates(
        latitude,
        longitude,
    ):

        await update.message.reply_text(
            "Invalid location. Please share your location again."
        )

        return LOCATION

    context.user_data[
        "latitude"
    ] = latitude

    context.user_data[
        "longitude"
    ] = longitude

    geofence_ok, geofence_message = (
        verify_geofence(
            latitude,
            longitude,
        )
    )

    context.user_data[
        "geofence_ok"
    ] = geofence_ok

    await update.message.reply_text(

        f"✅ *Location recorded*\n\n"

        f"`{latitude:.6f}, {longitude:.6f}`\n\n"

        f"{geofence_message}\n\n"

        "*Step 4/5 — Craft Evidence*\n\n"

        "Send a short video showing "
        "your craft or process.",

        reply_markup=ReplyKeyboardRemove(),

        parse_mode="Markdown",
    )

    return VIDEO


# ============================================================
# VIDEO
# ============================================================

async def handle_video(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> int:

    video_id = None

    if update.message.video:

        video_id = (
            update.message.video.file_id
        )

    elif update.message.video_note:

        video_id = (
            update.message.video_note.file_id
        )

    if not video_id:

        await update.message.reply_text(
            "Please send a video or video note."
        )

        return VIDEO

    # --------------------------------------------------------
    # VIDEO IS NOT STORED.
    #
    # Telegram file is only acknowledged as
    # verification evidence.
    # --------------------------------------------------------

    context.user_data[
        "video_received"
    ] = True

    await update.message.reply_text(

        "✅ *Craft evidence received.*\n\n"

        "*Step 5/5 — Your Story*\n\n"

        "Now send a short voice note in "
        "your own language telling us about "
        "your craft and heritage.",

        parse_mode="Markdown",
    )

    return VOICE


# ============================================================
# VOICE
# ============================================================

async def handle_voice(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> int:

    if not update.message.voice:

        await update.message.reply_text(
            "Please send a voice note."
        )

        return VOICE

    voice_file_id = (
        update.message.voice.file_id
    )

    processing_message = (
        await update.message.reply_text(

            "⏳ *Your Heritage Pin is being processed...*\n\n"

            "Checking the location, processing "
            "your story and creating your profile.",

            parse_mode="Markdown",
        )
    )

    # Short demo delay.
    await asyncio.sleep(3)

    # --------------------------------------------------------
    # AI
    # --------------------------------------------------------

    ai_result = (
        process_nvidia_nim_asr(
            voice_file_id
        )
    )

    # --------------------------------------------------------
    # LOCATION
    # --------------------------------------------------------

    latitude = float(
        context.user_data[
            "latitude"
        ]
    )

    longitude = float(
        context.user_data[
            "longitude"
        ]
    )

    geofence_ok = bool(
        context.user_data.get(
            "geofence_ok",
            False,
        )
    )

    if not geofence_ok:

        await processing_message.edit_text(

            "❌ *Verification failed.*\n\n"

            "The submitted location is outside "
            "the current Heritage Pin pilot boundary.",

            parse_mode="Markdown",
        )

        return ConversationHandler.END

    # --------------------------------------------------------
    # CREDENTIALS
    # --------------------------------------------------------

    pin_id = generate_pin_id()

    password = generate_password()

    firebase_email = (
        firebase_email_for_pin(
            pin_id
        )
    )

    try:

        # ====================================================
        # CREATE FIREBASE AUTH USER
        # ====================================================

        auth_result = (
            firebase_create_user(
                firebase_email,
                password,
            )
        )

        owner_uid = (
            auth_result["localId"]
        )

        auth_id_token = (
            auth_result["idToken"]
        )

        # ====================================================
        # RECORD
        # ====================================================

        timestamp = int(
            time.time()
        )

        record = {

            "id":
                pin_id,

            "type":
                "Artisan",

            "name":
                context.user_data.get(
                    "name",
                    "",
                ),

            "craft":
                context.user_data.get(
                    "craft",
                    "",
                ),

            "place":
                "Location shared by custodian",

            "lat":
                latitude,

            "lng":
                longitude,

            # Verified but not yet claimed.
            "status":
                "verified",

            "claimed":
                False,

            "story":
                ai_result[
                    "translated_text"
                ],

            "native_transcript":
                ai_result[
                    "raw_transcript"
                ],

            "language":
                ai_result[
                    "detected_language"
                ],

            "ai_confidence":
                ai_result[
                    "confidence_score"
                ],

            "verification": {

                "geofence":
                    True,

                "video_received":
                    bool(
                        context.user_data.get(
                            "video_received",
                            False,
                        )
                    ),

                "voice_received":
                    True,

                "verified_at":
                    timestamp,

                "method":
                    "demo-verification-pipeline",
            },

            "profile": {

                "bio":
                    "",

                "phone":
                    "",

                "whatsapp":
                    "",

                "website":
                    "",

                "photos":
                    [],
            },

            "reviews":
                [],

            # PRIVATE
            "owner_uid":
                owner_uid,

            "auth_email":
                firebase_email,

            "telegram_user_id":
                context.user_data.get(
                    "telegram_user_id"
                ),

            "credential_created_at":
                timestamp,
        }

        # ====================================================
        # SAVE TO RTDB
        # ====================================================

        firebase_put(

            "heritage_pins/"
            + quote(
                pin_id,
                safe="",
            ),

            record,

            id_token=auth_id_token,
        )

    except Exception as exc:

        logger.exception(
            "Heritage Pin creation failed"
        )

        await processing_message.edit_text(

            "❌ *Could not create your Heritage Pin.*\n\n"

            f"`{clean_text(str(exc), 500)}`\n\n"

            "Please check Firebase Authentication "
            "and Realtime Database settings and "
            "try `/start` again.",

            parse_mode="Markdown",
        )

        return ConversationHandler.END

    # ========================================================
    # SEND CREDENTIALS
    # ========================================================

    final_message = (

        "🎉 *HERITAGE PIN CREATED!*\n\n"

        "🆔 *Heritage ID*\n"
        f"`{pin_id}`\n\n"

        "🔑 *Password*\n"
        f"`{password}`\n\n"

        "────────────────────\n\n"

        "✅ Location verified\n"
        "✅ Craft evidence received\n"
        "✅ Story processed\n"
        "✅ Heritage profile created\n\n"

        "────────────────────\n\n"

        "⚪ *NOT CLAIMED*\n\n"

        "Your Heritage Pin is now ready "
        "to appear on the map.\n\n"

        "Open the Heritage Pin website and "
        "choose *Claim this profile*.\n\n"

        "Enter the Heritage ID and password "
        "above to take control of your profile.\n\n"

        "After claiming, you can update your "
        "story, bio, contact information and "
        "profile photos.\n\n"

        "⚠️ *Keep these credentials safe.*"
    )

    await processing_message.edit_text(

        final_message,

        parse_mode="Markdown",

        disable_web_page_preview=True,
    )

    return ConversationHandler.END


# ============================================================
# CANCEL
# ============================================================

async def cancel(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> int:

    await update.message.reply_text(

        "Process cancelled.",

        reply_markup=ReplyKeyboardRemove(),
    )

    return ConversationHandler.END


# ============================================================
# FLASK SERVER
# ============================================================

server = Flask(
    __name__
)

CORS(
    server,
    resources={
        r"/api/*": {
            "origins": "*"
        }
    },
)


# ============================================================
# HEALTH CHECK
# ============================================================

@server.get("/")
def health():

    return jsonify(
        {
            "service":
                "Heritage Pin API",

            "status":
                "online",

            "storage":
                "none",

            "database":
                "firebase-realtime-database",

            "telegram":
                BOT_USERNAME,
        }
    )


# ============================================================
# CONFIG
# ============================================================

@server.get("/api/config")
def api_config():

    return jsonify(
        {
            "telegram":
                BOT_USERNAME,

            "speech":
                False,

            "languages":
                [
                    "hi-IN",
                    "en-US",
                ],
        }
    )


# ============================================================
# PUBLIC PINS
# ============================================================

@server.get("/api/pins")
def api_pins():

    try:

        data = (
            firebase_get(
                "heritage_pins"
            )
            or {}
        )

        pins = []

        if isinstance(
            data,
            dict,
        ):

            for pin_id, record in data.items():

                if not isinstance(
                    record,
                    dict,
                ):
                    continue

                record = dict(
                    record
                )

                record.setdefault(
                    "id",
                    pin_id,
                )

                record.setdefault(
                    "status",
                    "verified",
                )

                record.setdefault(
                    "claimed",
                    False,
                )

                record.setdefault(
                    "profile",
                    {},
                )

                record.setdefault(
                    "reviews",
                    [],
                )

                # Only verified records are public.
                if (
                    record.get(
                        "status"
                    )
                    != "verified"
                ):
                    continue

                pins.append(
                    public_pin(
                        record
                    )
                )

        return jsonify(
            {
                "pins":
                    pins
            }
        )

    except Exception:

        logger.exception(
            "Could not load Heritage Pins."
        )

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        "Could not load Heritage Pins.",
                }
            ),
            500,
        )


# ============================================================
# CLAIM PROFILE
# ============================================================

@server.post("/api/claim")
def api_claim():

    # --------------------------------------------------------
    # RATE LIMIT
    # --------------------------------------------------------

    remote_ip = (
        request.headers.get(
            "X-Forwarded-For"
        )
        or
        request.remote_addr
        or
        "unknown"
    )

    remote_ip = (
        remote_ip
        .split(",")[0]
        .strip()
    )

    now = time.time()

    previous = (
        claim_attempts.get(
            remote_ip,
            0,
        )
    )

    if (
        now - previous
        < 3
    ):

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        "Please wait a moment before trying again.",
                }
            ),
            429,
        )

    claim_attempts[
        remote_ip
    ] = now

    # --------------------------------------------------------
    # REQUEST
    # --------------------------------------------------------

    body = (
        request.get_json(
            silent=True
        )
        or {}
    )

    pin_id = (
        clean_text(
            body.get(
                "pin_id"
            ),
            30,
        )
        .upper()
    )

    password = str(
        body.get(
            "password"
        )
        or ""
    )

    if not valid_pin_id(
        pin_id
    ):

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        "Enter a valid Heritage ID.",
                }
            ),
            400,
        )

    if not password:

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        "Password is required.",
                }
            ),
            400,
        )

    try:

        # ----------------------------------------------------
        # GET PIN
        # ----------------------------------------------------

        record = firebase_get(

            "heritage_pins/"
            + quote(
                pin_id,
                safe="",
            )
        )

        if not isinstance(
            record,
            dict,
        ):

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "Heritage Pin not found.",
                    }
                ),
                404,
            )

        # ----------------------------------------------------
        # CHECK VERIFIED
        # ----------------------------------------------------

        if (
            record.get(
                "status"
            )
            != "verified"
        ):

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "This Heritage Pin is not verified.",
                    }
                ),
                403,
            )

        # ----------------------------------------------------
        # FIREBASE LOGIN
        # ----------------------------------------------------

        firebase_email = (
            record.get(
                "auth_email"
            )
            or
            firebase_email_for_pin(
                pin_id
            )
        )

        auth_result = (
            firebase_sign_in(
                firebase_email,
                password,
            )
        )

        uid = auth_result[
            "localId"
        ]

        id_token = auth_result[
            "idToken"
        ]

        # ----------------------------------------------------
        # OWNERSHIP
        # ----------------------------------------------------

        if (
            uid
            !=
            record.get(
                "owner_uid"
            )
        ):

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "Credential ownership mismatch.",
                    }
                ),
                403,
            )

        # ----------------------------------------------------
        # CLAIM
        # ----------------------------------------------------

        firebase_patch(

            "heritage_pins/"
            + quote(
                pin_id,
                safe="",
            ),

            {
                "claimed":
                    True,

                "claimed_at":
                    int(
                        time.time()
                    ),
            },

            id_token=id_token,
        )

        # ----------------------------------------------------
        # LATEST
        # ----------------------------------------------------

        latest = firebase_get(

            "heritage_pins/"
            + quote(
                pin_id,
                safe="",
            )
        )

        if not isinstance(
            latest,
            dict,
        ):
            latest = record

        latest[
            "id"
        ] = pin_id

        latest[
            "claimed"
        ] = True

        return jsonify(
            {
                "success":
                    True,

                "token":
                    id_token,

                "expires_in":
                    int(
                        auth_result.get(
                            "expiresIn",
                            "3600",
                        )
                    ),

                "pin":
                    public_pin(
                        latest
                    ),
            }
        )

    except Exception as exc:

        logger.warning(
            "Claim failed for %s: %s",
            pin_id,
            exc,
        )

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        "Incorrect Heritage ID or password.",
                }
            ),
            401,
        )


# ============================================================
# BEARER TOKEN
# ============================================================

def get_bearer_token() -> Optional[str]:

    authorization = (
        request.headers.get(
            "Authorization",
            "",
        )
    )

    if not authorization.startswith(
        "Bearer "
    ):
        return None

    return authorization[
        7:
    ].strip() or None


# ============================================================
# UPDATE PROFILE
# ============================================================

@server.put("/api/profile")
def api_profile():

    id_token = (
        get_bearer_token()
    )

    if not id_token:

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        "Authentication required.",
                }
            ),
            401,
        )

    body = (
        request.get_json(
            silent=True
        )
        or {}
    )

    pin_id = (
        clean_text(
            body.get(
                "pin_id"
            ),
            30,
        )
        .upper()
    )

    if not valid_pin_id(
        pin_id
    ):

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        "Invalid Heritage ID.",
                }
            ),
            400,
        )

    try:

        # ----------------------------------------------------
        # VERIFY FIREBASE USER
        # ----------------------------------------------------

        firebase_user = (
            firebase_lookup_token(
                id_token
            )
        )

        uid = firebase_user[
            "localId"
        ]

        # ----------------------------------------------------
        # GET CURRENT
        # ----------------------------------------------------

        current = firebase_get(

            "heritage_pins/"
            + quote(
                pin_id,
                safe="",
            )
        )

        if not isinstance(
            current,
            dict,
        ):

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "Heritage Pin not found.",
                    }
                ),
                404,
            )

        # ----------------------------------------------------
        # OWNER CHECK
        # ----------------------------------------------------

        if (
            current.get(
                "owner_uid"
            )
            != uid
        ):

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "You do not own this Heritage Pin.",
                    }
                ),
                403,
            )

        # ----------------------------------------------------
        # INPUT
        # ----------------------------------------------------

        profile_input = (
            body.get(
                "profile"
            )
            or {}
        )

        old_profile = (
            current.get(
                "profile"
            )
            or {}
        )

        name = clean_text(
            profile_input.get(
                "name",
                current.get(
                    "name",
                    "",
                ),
            ),
            100,
        )

        craft = clean_text(
            profile_input.get(
                "craft",
                current.get(
                    "craft",
                    "",
                ),
            ),
            100,
        )

        story = clean_text(
            profile_input.get(
                "story",
                current.get(
                    "story",
                    "",
                ),
            ),
            3000,
        )

        bio = clean_text(
            profile_input.get(
                "bio",
                old_profile.get(
                    "bio",
                    "",
                ),
            ),
            1200,
        )

        phone = clean_text(
            profile_input.get(
                "phone",
                old_profile.get(
                    "phone",
                    "",
                ),
            ),
            30,
        )

        whatsapp = clean_text(
            profile_input.get(
                "whatsapp",
                old_profile.get(
                    "whatsapp",
                    "",
                ),
            ),
            30,
        )

        website = clean_text(
            profile_input.get(
                "website",
                old_profile.get(
                    "website",
                    "",
                ),
            ),
            300,
        )

        # ----------------------------------------------------
        # PHOTOS
        # ----------------------------------------------------

        photos = profile_input.get(
            "photos",
            old_profile.get(
                "photos",
                [],
            ),
        )

        if not isinstance(
            photos,
            list,
        ):

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "Photos must be an array.",
                    }
                ),
                400,
            )

        if len(photos) > 3:

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "Maximum 3 photos.",
                    }
                ),
                400,
            )

        valid_photos = []

        total_size = 0

        for photo in photos:

            if not isinstance(
                photo,
                str,
            ):
                continue

            if not photo.startswith(
                "data:image/"
            ):
                continue

            if len(photo) > 450_000:

                return (
                    jsonify(
                        {
                            "success":
                                False,

                            "error":
                                "Each image is too large.",
                        }
                    ),
                    400,
                )

            valid_photos.append(
                photo
            )

            total_size += len(
                photo
            )

        if total_size > 900_000:

            return (
                jsonify(
                    {
                        "success":
                            False,

                        "error":
                            "Total photo size is too large.",
                    }
                ),
                400,
            )

        # ----------------------------------------------------
        # UPDATE
        # ----------------------------------------------------

        updates = {

            "name":
                name,

            "craft":
                craft,

            "story":
                story,

            "profile": {

                "bio":
                    bio,

                "phone":
                    phone,

                "whatsapp":
                    whatsapp,

                "website":
                    website,

                "photos":
                    valid_photos,
            },

            "claimed":
                True,
        }

        firebase_patch(

            "heritage_pins/"
            + quote(
                pin_id,
                safe="",
            ),

            updates,

            id_token=id_token,
        )

        # ----------------------------------------------------
        # LATEST
        # ----------------------------------------------------

        latest = firebase_get(

            "heritage_pins/"
            + quote(
                pin_id,
                safe="",
            )
        )

        if not isinstance(
            latest,
            dict,
        ):
            latest = current

        latest[
            "id"
        ] = pin_id

        return jsonify(
            {
                "success":
                    True,

                "pin":
                    public_pin(
                        latest
                    ),
            }
        )

    except Exception as exc:

        logger.exception(
            "Profile update failed."
        )

        return (
            jsonify(
                {
                    "success":
                        False,

                    "error":
                        f"Profile update failed: {exc}",
                }
            ),
            500,
        )


# ============================================================
# RUN FLASK
# ============================================================

def run_flask() -> None:

    server.run(

        host="0.0.0.0",

        port=PORT,

        debug=False,

        use_reloader=False,
    )


# ============================================================
# MAIN
# ============================================================

def main() -> None:

    required_vars = [
        "BOT_TOKEN",
        "FIREBASE_API_KEY",
        "FIREBASE_DATABASE_URL",
        "FIREBASE_PROJECT_ID",
    ]

    missing = [
        name for name in required_vars
        if not os.environ.get(name)
    ]

    if missing:

        raise RuntimeError(
            "Missing required environment variables: "
            + ", ".join(missing)
            + ". Set them in Render's Environment tab "
            "(or a local .env file) before running."
        )

    # --------------------------------------------------------
    # START FLASK
    # --------------------------------------------------------

    flask_thread = threading.Thread(

        target=run_flask,

        name="heritage-pin-flask",

        daemon=True,
    )

    flask_thread.start()

    # --------------------------------------------------------
    # START TELEGRAM BOT
    # --------------------------------------------------------

    application = (
        ApplicationBuilder()
        .token(
            BOT_TOKEN
        )
        .build()
    )

    conversation = ConversationHandler(

        entry_points=[
            CommandHandler(
                "start",
                start,
            )
        ],

        states={

            NAME: [
                MessageHandler(
                    filters.TEXT
                    & ~filters.COMMAND,
                    handle_name,
                )
            ],

            CRAFT: [
                MessageHandler(
                    filters.TEXT
                    & ~filters.COMMAND,
                    handle_craft,
                )
            ],

            LOCATION: [
                MessageHandler(
                    filters.LOCATION,
                    handle_location,
                )
            ],

            VIDEO: [
                MessageHandler(
                    filters.VIDEO
                    | filters.VIDEO_NOTE,
                    handle_video,
                )
            ],

            VOICE: [
                MessageHandler(
                    filters.VOICE,
                    handle_voice,
                )
            ],
        },

        fallbacks=[
            CommandHandler(
                "cancel",
                cancel,
            )
        ],

        allow_reentry=True,
    )

    application.add_handler(
        conversation
    )

    logger.info(
        "=========================================="
    )

    logger.info(
        "HERITAGE PIN BACKEND STARTED"
    )

    logger.info(
        "Bot: @%s",
        BOT_USERNAME,
    )

    logger.info(
        "Firebase project: %s",
        FIREBASE_PROJECT_ID,
    )

    logger.info(
        "Firebase database: %s",
        FIREBASE_DATABASE_URL,
    )

    logger.info(
        "Firebase Storage: NOT USED"
    )

    logger.info(
        "Flask port: %s",
        PORT,
    )

    logger.info(
        "=========================================="
    )

    application.run_polling(
        drop_pending_updates=True
    )


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()
