import os
import re
import json
import time
import requests
import phonenumbers
from flask import Flask, request, jsonify
from flask_cors import CORS
from datetime import datetime

app = Flask(__name__)
CORS(app)

check_history = []
session_counter = [0]


def normalize_number(raw_number):
    raw = raw_number.strip()
    if not raw:
        return None, "Empty number"
    
    try:
        parsed = phonenumbers.parse(raw, None)
        if not phonenumbers.is_valid_number(parsed):
            if not raw.startswith("+"):
                try:
                    parsed = phonenumbers.parse("+" + raw, None)
                    if phonenumbers.is_valid_number(parsed):
                        formatted = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
                        return formatted, None
                except Exception:
                    pass
            return None, f"Invalid number: {raw}"
        formatted = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
        return formatted, None
    except phonenumbers.NumberParseException as e:
        if not raw.startswith("+"):
            try:
                parsed = phonenumbers.parse("+" + raw, None)
                if phonenumbers.is_valid_number(parsed):
                    formatted = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
                    return formatted, None
            except Exception:
                pass
        return None, f"Could not parse number: {raw}"


def check_whatsapp(phone_e164):
    digits_only = re.sub(r"[^\d]", "", phone_e164)
    
    url = f"https://wa.me/{digits_only}"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Cache-Control": "max-age=0",
    }
    
    try:
        response = requests.get(url, headers=headers, timeout=10, allow_redirects=True)
        
        if response.status_code == 200:
            content = response.text.lower()
            
            if "open whatsapp" in content or "use whatsapp" in content:
                return True
            if "send message" in content and "whatsapp" in content:
                return True
            if f"wa.me/{digits_only}" in content and "chat" in content:
                return True
            if "invalid phone number" in content or "this phone number doesn't exist" in content:
                return False
            return True
        elif response.status_code == 404:
            return False
        else:
            return None
    except requests.RequestException:
        return None


@app.route("/api/check", methods=["POST"])
def check_numbers():
    data = request.get_json()
    if not data or "numbers" not in data:
        return jsonify({"error": "numbers field required"}), 400
    
    raw_numbers = data.get("numbers", [])
    if not isinstance(raw_numbers, list) or len(raw_numbers) == 0:
        return jsonify({"error": "numbers must be a non-empty array"}), 400
    
    if len(raw_numbers) > 100:
        return jsonify({"error": "Maximum 100 numbers per request"}), 400
    
    results = []
    with_whatsapp = 0
    without_whatsapp = 0
    
    for raw in raw_numbers:
        formatted, parse_err = normalize_number(str(raw))
        
        if parse_err:
            results.append({
                "number": str(raw),
                "formattedNumber": str(raw),
                "hasWhatsapp": False,
                "error": parse_err
            })
            without_whatsapp += 1
            continue
        
        has_wa = check_whatsapp(formatted)
        
        if has_wa is None:
            results.append({
                "number": str(raw),
                "formattedNumber": formatted,
                "hasWhatsapp": False,
                "error": "Could not determine (network issue)"
            })
            without_whatsapp += 1
        elif has_wa:
            results.append({
                "number": str(raw),
                "formattedNumber": formatted,
                "hasWhatsapp": True,
                "error": None
            })
            with_whatsapp += 1
        else:
            results.append({
                "number": str(raw),
                "formattedNumber": formatted,
                "hasWhatsapp": False,
                "error": None
            })
            without_whatsapp += 1
        
        time.sleep(0.3)
    
    session_counter[0] += 1
    session_id = session_counter[0]
    checked_at = datetime.utcnow().isoformat() + "Z"
    
    session = {
        "id": session_id,
        "total": len(results),
        "withWhatsapp": with_whatsapp,
        "withoutWhatsapp": without_whatsapp,
        "checkedAt": checked_at,
        "results": results
    }
    check_history.append(session)
    
    return jsonify(session)


@app.route("/api/history", methods=["GET"])
def get_history():
    history_summary = []
    for s in reversed(check_history):
        history_summary.append({
            "id": s["id"],
            "total": s["total"],
            "withWhatsapp": s["withWhatsapp"],
            "withoutWhatsapp": s["withoutWhatsapp"],
            "checkedAt": s["checkedAt"]
        })
    return jsonify(history_summary)


@app.route("/api/history/<int:session_id>", methods=["GET"])
def get_session(session_id):
    for s in check_history:
        if s["id"] == session_id:
            return jsonify(s)
    return jsonify({"error": "Session not found"}), 404


@app.route("/api/stats", methods=["GET"])
def get_stats():
    total_checks = len(check_history)
    total_numbers = sum(s["total"] for s in check_history)
    total_with_wa = sum(s["withWhatsapp"] for s in check_history)
    total_without_wa = sum(s["withoutWhatsapp"] for s in check_history)
    success_rate = round((total_with_wa / total_numbers * 100), 1) if total_numbers > 0 else 0
    
    return jsonify({
        "totalChecks": total_checks,
        "totalNumbersChecked": total_numbers,
        "totalWithWhatsapp": total_with_wa,
        "totalWithoutWhatsapp": total_without_wa,
        "successRate": success_rate
    })


@app.route("/api/healthz", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    port = int(os.environ.get("PYTHON_PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
