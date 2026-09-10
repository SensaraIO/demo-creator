#!/usr/bin/env -S uv run --script
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under those licenses.
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-genai>=2.7.0",
#     "Pillow>=10.0.0",
#     "pyautogui>=0.9.54",
#     "pyperclip>=1.9.0",
#     "pyobjc-framework-ApplicationServices>=10.3; sys_platform == 'darwin'",
#     "pyobjc-framework-Cocoa>=10.3; sys_platform == 'darwin'",
#     "pyobjc-framework-Quartz>=10.3; sys_platform == 'darwin'",
# ]
# ///

import argparse
import base64
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, ClassVar

from google import genai

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL = "gemini-3.8-flash"
DISABLED_SAFETY_POLICIES = [
    "financial_transactions",
    "sensitive_data_modification",
    "communication_tool",
    "account_creation",
    "data_modification",
    "user_consent_management",
    "legal_terms_and_agreements",
]


class AgentStopped(RuntimeError):
    pass


def load_gemini_api_key() -> bool:
    if os.environ.get("GEMINI_API_KEY"):
        return True
    key_file = os.path.join(os.path.expanduser("~"), ".config", "gemini", "api_key")
    try:
        with open(key_file) as fh:
            file_key = fh.read().strip()
        if file_key:
            os.environ["GEMINI_API_KEY"] = file_key
            return True
    except OSError:
        pass
    if sys.platform != "darwin":
        return False
    result = subprocess.run(
        [
            "security",
            "find-generic-password",
            "-a",
            os.environ.get("USER", ""),
            "-s",
            "gemini-api-key",
            "-w",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    api_key = result.stdout.strip()
    if result.returncode != 0 or not api_key:
        return False
    os.environ["GEMINI_API_KEY"] = api_key
    return True


def setup_android_env() -> Path:
    candidates = [
        os.environ.get("ANDROID_HOME"),
        os.environ.get("ANDROID_SDK_ROOT"),
        str(Path.home() / "Library/Android/sdk"),
        "/opt/homebrew/share/android-commandlinetools",
        "/usr/local/share/android-commandlinetools",
    ]
    android_home = next(
        (
            Path(path).expanduser()
            for path in candidates
            if path and Path(path).exists()
        ),
        None,
    )
    if android_home is None:
        raise RuntimeError("ANDROID_HOME was not found. Run setup_emulator.sh first.")

    os.environ["ANDROID_HOME"] = str(android_home)
    sdk_paths = [
        android_home / "cmdline-tools/latest/bin",
        android_home / "emulator",
        android_home / "platform-tools",
    ]
    current_path = os.environ.get("PATH", "").split(os.pathsep)
    os.environ["PATH"] = os.pathsep.join(
        [str(path) for path in sdk_paths if str(path) not in current_path]
        + current_path
    )
    return android_home


def adb_devices() -> list[str]:
    result = subprocess.run(
        ["adb", "devices"], capture_output=True, text=True, check=True
    )
    devices = []
    for line in result.stdout.splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 2 and fields[1] == "device":
            devices.append(fields[0])
    return devices


def start_emulator(avd_name: str, requested_device: str | None = None) -> str:
    setup_android_env()
    devices = adb_devices()
    if requested_device:
        if requested_device not in devices:
            raise RuntimeError(f"ADB device is not available: {requested_device}")
        return requested_device
    if devices:
        return next(
            (device for device in devices if device.startswith("emulator-")), devices[0]
        )

    print(f"Starting Android emulator '{avd_name}'...")
    with open(BASE_DIR / "emulator.log", "w") as log_file:
        subprocess.Popen(
            ["emulator", "-avd", avd_name, "-delay-adb"],
            stdout=log_file,
            stderr=log_file,
            start_new_session=True,
        )

    for _ in range(90):
        devices = adb_devices()
        if devices:
            device = next(
                (
                    candidate
                    for candidate in devices
                    if candidate.startswith("emulator-")
                ),
                devices[0],
            )
            booted = subprocess.run(
                ["adb", "-s", device, "shell", "getprop", "sys.boot_completed"],
                capture_output=True,
                text=True,
                check=False,
            )
            if booted.stdout.strip() == "1":
                print(f"Android emulator ready: {device}")
                return device
        time.sleep(2)
    raise RuntimeError(
        f"Android emulator '{avd_name}' did not boot within 180 seconds."
    )


class ADBBridge:
    def __init__(self, device_id: str):
        self.device_id = device_id
        self.prefix = ["adb", "-s", device_id]
        self.width, self.height = self._screen_size()

    def _run(self, args: list[str], check: bool = True) -> str:
        result = subprocess.run(
            self.prefix + args, capture_output=True, text=True, check=False
        )
        if check and result.returncode != 0:
            raise RuntimeError(f"ADB error: {result.stderr.strip()}")
        return result.stdout

    def _screen_size(self) -> tuple[int, int]:
        output = self._run(["shell", "wm", "size"])
        match = re.search(r"Physical size: (\d+)x(\d+)", output)
        return (int(match.group(1)), int(match.group(2))) if match else (1080, 1920)

    def _point(self, x: int, y: int) -> tuple[int, int]:
        x = min(999, max(0, int(x)))
        y = min(999, max(0, int(y)))
        return int(x / 1000 * self.width), int(y / 1000 * self.height)

    def click(self, y: int, x: int, **_: Any) -> None:
        px, py = self._point(x, y)
        self._run(["shell", "input", "tap", str(px), str(py)])

    def type(self, text: str, press_enter: bool = False, **_: Any) -> None:
        escaped = text.replace("%", "\\%").replace(" ", "%s")
        self._run(["shell", "input", "text", escaped])
        if press_enter:
            self._run(["shell", "input", "keyevent", "66"])

    def open_app(self, app_name: str, **_: Any) -> None:
        aliases = {
            "chrome": "com.android.chrome",
            "clock": "com.google.android.deskclock",
            "contacts": "com.google.android.contacts",
            "files": "com.google.android.documentsui",
            "messages": "com.google.android.apps.messaging",
            "phone": "com.google.android.dialer",
            "photos": "com.google.android.apps.photos",
            "play store": "com.android.vending",
            "settings": "com.android.settings",
        }
        package_name = aliases.get(app_name.lower(), app_name)
        output = self._run(
            [
                "shell",
                "monkey",
                "--pct-syskeys",
                "0",
                "-p",
                package_name,
                "-c",
                "android.intent.category.LAUNCHER",
                "1",
            ],
            check=False,
        )
        if "No activities found" in output or "monkey aborted" in output:
            raise RuntimeError(f"App is unavailable: {app_name}")

    def list_apps(self, **_: Any) -> dict[str, Any]:
        output = self._run(
            [
                "shell",
                "cmd",
                "package",
                "query-activities",
                "--brief",
                "-a",
                "android.intent.action.MAIN",
                "-c",
                "android.intent.category.LAUNCHER",
            ],
            check=False,
        )
        packages = sorted(
            {
                line.strip().split("/", 1)[0]
                for line in output.splitlines()
                if "/" in line and not line.startswith("priority=")
            }
        )
        if not packages:
            output = self._run(["shell", "pm", "list", "packages"])
            packages = sorted(
                line.split(":", 1)[1]
                for line in output.splitlines()
                if line.startswith("package:")
            )
        return {"apps": packages}

    def wait(self, seconds: int = 1, **_: Any) -> None:
        time.sleep(max(0, seconds))

    def go_back(self, **_: Any) -> None:
        self._run(["shell", "input", "keyevent", "4"])

    def drag_and_drop(
        self,
        start_y: int,
        start_x: int,
        end_y: int,
        end_x: int,
        **_: Any,
    ) -> None:
        start = self._point(start_x, start_y)
        end = self._point(end_x, end_y)
        self._run(
            [
                "shell",
                "input",
                "swipe",
                str(start[0]),
                str(start[1]),
                str(end[0]),
                str(end[1]),
                "400",
            ]
        )

    def long_press(self, y: int, x: int, seconds: int = 2, **_: Any) -> None:
        px, py = self._point(x, y)
        self._run(
            [
                "shell",
                "input",
                "swipe",
                str(px),
                str(py),
                str(px),
                str(py),
                str(max(0, seconds) * 1000),
            ]
        )

    def press_key(self, key: str, **_: Any) -> None:
        keymap = {
            "home": "3",
            "back": "4",
            "enter": "66",
            "return": "66",
            "backspace": "67",
            "delete": "67",
            "menu": "82",
            "app_switch": "187",
            "recent": "187",
            "tab": "61",
            "space": "62",
            "escape": "111",
            "volume_up": "24",
            "volume_down": "25",
            "power": "26",
        }
        self._run(["shell", "input", "keyevent", keymap.get(key.lower(), key)])

    def take_screenshot(self, **_: Any) -> None:
        pass

    def screenshot(self) -> bytes:
        result = subprocess.run(
            self.prefix + ["exec-out", "screencap", "-p"],
            capture_output=True,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.startswith(b"\x89PNG"):
            raise RuntimeError("ADB could not capture a PNG screenshot.")
        return result.stdout

    def state(self) -> dict[str, Any]:
        return {
            "device_id": self.device_id,
            "screen_size": [self.width, self.height],
        }

    def close(self) -> None:
        pass


class MacDesktopBridge:
    KEY_ALIASES: ClassVar[dict[str, str]] = {
        "alt": "option",
        "arrowdown": "down",
        "arrowleft": "left",
        "arrowright": "right",
        "arrowup": "up",
        "backspace": "backspace",
        "cmd": "command",
        "control": "ctrl",
        "del": "delete",
        "esc": "escape",
        "meta": "command",
        "option": "option",
        "pagedown": "pagedown",
        "pageup": "pageup",
        "return": "enter",
        "spacebar": "space",
    }

    def __init__(self, display_index: int = 0, require_accessibility: bool = True):
        if sys.platform != "darwin":
            raise RuntimeError(
                "Desktop and host-browser modes currently require macOS."
            )

        import pyautogui
        import pyperclip
        import Quartz
        from ApplicationServices import AXIsProcessTrusted
        from Foundation import NSMutableData
        from PIL import Image

        self.gui = pyautogui
        self.clipboard = pyperclip
        self.quartz = Quartz
        self.mutable_data = NSMutableData
        self.image = Image
        self.gui.FAILSAFE = False
        self.gui.PAUSE = 0.08

        error, displays, _ = Quartz.CGGetActiveDisplayList(32, None, None)
        if error:
            raise RuntimeError(f"CoreGraphics could not list displays: {error}")
        self.displays = sorted(
            displays, key=lambda display: not bool(Quartz.CGDisplayIsMain(display))
        )
        if display_index < 0 or display_index >= len(self.displays):
            raise RuntimeError(
                f"Display index {display_index} is invalid. "
                f"Available indexes: 0-{len(self.displays) - 1}"
            )
        self.display_index = display_index
        self.display_id = self.displays[display_index]
        self.bounds = Quartz.CGDisplayBounds(self.display_id)
        self.accessibility_trusted = bool(AXIsProcessTrusted())
        if require_accessibility and not self.accessibility_trusted:
            raise RuntimeError(
                "macOS Accessibility access is not granted. Enable it for the terminal "
                "or agent host in System Settings > Privacy & Security > Accessibility."
            )

    @classmethod
    def _key(cls, key: str) -> str:
        normalized = key.strip().lower().replace("_", "")
        return cls.KEY_ALIASES.get(normalized, normalized)

    def _point(self, x: int, y: int) -> tuple[int, int]:
        x = min(999, max(0, int(x)))
        y = min(999, max(0, int(y)))
        return (
            int(self.bounds.origin.x + x / 1000 * self.bounds.size.width),
            int(self.bounds.origin.y + y / 1000 * self.bounds.size.height),
        )

    def _move(self, x: int, y: int) -> tuple[int, int]:
        point = self._point(x, y)
        self.gui.moveTo(*point, duration=0.08)
        return point

    def _paste(self, text: str) -> None:
        previous = self.clipboard.paste()
        try:
            self.clipboard.copy(text)
            self.gui.hotkey("command", "v")
            time.sleep(0.08)
        finally:
            self.clipboard.copy(previous)

    def click(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)
        self.gui.click()

    def double_click(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)
        self.gui.click(clicks=2, interval=0.12)

    def triple_click(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)
        self.gui.click(clicks=3, interval=0.12)

    def middle_click(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)
        self.gui.click(button="middle")

    def right_click(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)
        self.gui.click(button="right")

    def mouse_down(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)
        self.gui.mouseDown(button="left")

    def mouse_up(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)
        self.gui.mouseUp(button="left")

    def move(self, y: int, x: int, **_: Any) -> None:
        self._move(x, y)

    def type(self, text: str, press_enter: bool = False, **_: Any) -> None:
        self._paste(text)
        if press_enter:
            self.gui.press("enter")

    def drag_and_drop(
        self,
        start_y: int,
        start_x: int,
        end_y: int,
        end_x: int,
        **_: Any,
    ) -> None:
        self._move(start_x, start_y)
        destination = self._point(end_x, end_y)
        self.gui.dragTo(*destination, duration=0.45, button="left")

    def wait(self, seconds: int = 1, **_: Any) -> None:
        time.sleep(max(0, seconds))

    def press_key(self, key: str, **_: Any) -> None:
        self.gui.press(self._key(key))

    def key_down(self, key: str, **_: Any) -> None:
        self.gui.keyDown(self._key(key))

    def key_up(self, key: str, **_: Any) -> None:
        self.gui.keyUp(self._key(key))

    def hotkey(self, keys: list[str] | str, **_: Any) -> None:
        if isinstance(keys, str):
            keys = re.split(r"\s*\+\s*", keys)
        self.gui.hotkey(*(self._key(key) for key in keys))

    def take_screenshot(self, **_: Any) -> None:
        pass

    def scroll(
        self,
        y: int,
        x: int,
        direction: str,
        magnitude_in_pixels: int = 300,
        **_: Any,
    ) -> None:
        self._move(x, y)
        magnitude = max(0, int(magnitude_in_pixels))
        deltas = {
            "up": (magnitude, 0),
            "down": (-magnitude, 0),
            "left": (0, magnitude),
            "right": (0, -magnitude),
        }
        if direction.lower() not in deltas:
            raise ValueError(f"Unsupported scroll direction: {direction}")
        vertical, horizontal = deltas[direction.lower()]
        event = self.quartz.CGEventCreateScrollWheelEvent(
            None,
            self.quartz.kCGScrollEventUnitPixel,
            2,
            vertical,
            horizontal,
        )
        self.quartz.CGEventPost(self.quartz.kCGHIDEventTap, event)

    def screenshot(self) -> bytes:
        image = self.quartz.CGDisplayCreateImage(self.display_id)
        if image is None:
            # CGDisplayCreateImage can intermittently return None even when the
            # launching terminal has Screen Recording access. The system
            # screencapture utility uses the same granted TCC permission and is
            # a reliable fallback.
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as output:
                output_path = Path(output.name)
            try:
                result = subprocess.run(
                    [
                        "/usr/sbin/screencapture",
                        "-x",
                        "-D",
                        str(self.display_index + 1),
                        str(output_path),
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                png = output_path.read_bytes() if output_path.exists() else b""
                if result.returncode != 0 or not png.startswith(b"\x89PNG"):
                    detail = result.stderr.strip()
                    raise RuntimeError(
                        "Could not capture the display. Grant Screen Recording access "
                        "in System Settings > Privacy & Security > Screen Recording."
                        + (f" ({detail})" if detail else "")
                    )
            finally:
                output_path.unlink(missing_ok=True)
        else:
            data = self.mutable_data.data()
            destination = self.quartz.CGImageDestinationCreateWithData(
                data, "public.png", 1, None
            )
            self.quartz.CGImageDestinationAddImage(destination, image, None)
            if not self.quartz.CGImageDestinationFinalize(destination):
                raise RuntimeError("CoreGraphics could not encode the screenshot as PNG.")
            png = bytes(data)
        target_size = (int(self.bounds.size.width), int(self.bounds.size.height))
        with self.image.open(io.BytesIO(png)) as screenshot:
            if screenshot.size == target_size:
                return png
            screenshot = screenshot.resize(target_size, self.image.Resampling.LANCZOS)
            output = io.BytesIO()
            screenshot.save(output, format="PNG", optimize=True)
            return output.getvalue()

    def state(self) -> dict[str, Any]:
        return {
            "display_index": self.display_index,
            "display_origin": [int(self.bounds.origin.x), int(self.bounds.origin.y)],
            "display_size": [
                int(self.bounds.size.width),
                int(self.bounds.size.height),
            ],
        }

    def check(self) -> dict[str, Any]:
        screenshot = self.screenshot()
        return {
            **self.state(),
            "display_count": len(self.displays),
            "accessibility": self.accessibility_trusted,
            # Without capture permission macOS can return only the wallpaper.
            "screen_recording": bool(self.quartz.CGPreflightScreenCaptureAccess()),
            "screenshot": screenshot.startswith(b"\x89PNG"),
            "screenshot_bytes": len(screenshot),
        }

    def close(self) -> None:
        pass


class MacBrowserBridge(MacDesktopBridge):
    def __init__(self, browser_app: str, display_index: int = 0):
        available = subprocess.run(
            ["open", "-Ra", browser_app], capture_output=True, check=False
        )
        if available.returncode != 0:
            raise RuntimeError(f"macOS application was not found: {browser_app}")
        super().__init__(display_index=display_index)
        self.browser_app = browser_app
        subprocess.run(["open", "-a", browser_app], check=True)
        time.sleep(1)

    def navigate(self, url: str, **_: Any) -> None:
        subprocess.run(["open", "-a", self.browser_app], check=True)
        time.sleep(0.2)
        self.gui.hotkey("command", "l")
        self._paste(url)
        self.gui.press("enter")

    def go_back(self, **_: Any) -> None:
        self.gui.hotkey("command", "[")

    def go_forward(self, **_: Any) -> None:
        self.gui.hotkey("command", "]")

    def state(self) -> dict[str, Any]:
        return {**super().state(), "browser_app": self.browser_app}


def computer_use_tool(environment: str) -> dict[str, Any]:
    return {
        "type": "computer_use",
        "environment": environment,
        "enable_prompt_injection_detection": False,
        "disabled_safety_policies": DISABLED_SAFETY_POLICIES,
    }


def safety_value(safety_decision: Any, key: str) -> Any:
    if isinstance(safety_decision, dict):
        return safety_decision.get(key)
    return getattr(safety_decision, key, None)


def confirm_safety(arguments: dict[str, Any]) -> bool:
    safety_decision = arguments.get("safety_decision")
    if not safety_decision:
        return False

    decision = str(safety_value(safety_decision, "decision") or "").lower()
    explanation = str(safety_value(safety_decision, "explanation") or "")
    if decision == "blocked":
        raise AgentStopped(
            f"Gemini blocked the requested action. {explanation}".strip()
        )
    if decision != "require_confirmation":
        return False
    if not sys.stdin.isatty():
        raise AgentStopped(
            "Gemini requires user confirmation for the next action, but stdin is not "
            f"interactive. {explanation}".strip()
        )

    print(f"Gemini requires confirmation: {explanation or 'No explanation supplied.'}")
    confirmed = input("Execute this action? [y/N] ").strip().lower() in {"y", "yes"}
    if not confirmed:
        raise AgentStopped("The user declined the requested action.")
    return True


def print_usage(interaction: Any) -> None:
    u = getattr(interaction, "usage", None)
    if not u:
        return
    print(
        "[usage] "
        + json.dumps(
            {
                "input": getattr(u, "total_input_tokens", 0),
                "output": getattr(u, "total_output_tokens", 0),
                "thought": getattr(u, "total_thought_tokens", 0),
                "tool_use": getattr(u, "total_tool_use_tokens", 0),
                "cached": getattr(u, "total_cached_tokens", 0),
                "total": getattr(u, "total_tokens", 0),
            }
        )
    )


def output_text(interaction: Any) -> str:
    direct = getattr(interaction, "output_text", None)
    if direct:
        return direct
    chunks = []
    for step in getattr(interaction, "steps", []):
        if getattr(step, "type", None) != "model_output":
            continue
        for block in getattr(step, "content", []) or []:
            if getattr(block, "type", None) == "text":
                chunks.append(getattr(block, "text", ""))
    return " ".join(chunk for chunk in chunks if chunk)


def function_responses(
    calls: list[Any], bridge: Any
) -> tuple[list[dict[str, Any]], bool]:
    results = []
    for call in calls:
        arguments = dict(call.arguments)
        intent = arguments.get("intent", "")
        print(f"[{call.name}] {intent}")
        acknowledged = confirm_safety(arguments)
        handler = getattr(bridge, call.name, None)
        result = {"status": "ok"}
        if handler is None:
            result = {"status": "error", "error": f"Unknown action: {call.name}"}
        else:
            try:
                value = handler(**arguments)
                if isinstance(value, dict):
                    result.update(value)
            except Exception as error:  # noqa: BLE001
                result = {"status": "error", "error": str(error)}
        if acknowledged:
            result["safety_acknowledgement"] = True
        print(f"  {json.dumps(result, ensure_ascii=True)}")
        results.append((call.name, call.id, result))
        time.sleep(0.35)

    screenshot = bridge.screenshot()
    state = bridge.state()
    encoded = base64.b64encode(screenshot).decode("ascii")
    responses = []
    for name, call_id, result in results:
        responses.append(
            {
                "type": "function_result",
                "name": name,
                "call_id": call_id,
                "result": [
                    {
                        "type": "text",
                        "text": json.dumps({**state, **result}),
                    },
                    {
                        "type": "image",
                        "data": encoded,
                        "mime_type": "image/png",
                    },
                ],
            }
        )
    return responses, bool(results)


def create_bridge(args: argparse.Namespace) -> Any:
    if args.environment == "mobile":
        device_id = start_emulator(args.avd, args.device_id)
        return ADBBridge(device_id)
    if args.environment == "browser":
        return MacBrowserBridge(args.browser_app, args.display)
    return MacDesktopBridge(args.display)


def run_agent(args: argparse.Namespace) -> int:
    task = " ".join(args.task).strip()
    system_instruction = (
        f"You control a {args.environment} environment through the provided UI actions. "
        "Complete the user's task, inspect the updated screenshot after actions, and "
        "state the result when finished."
    )
    if args.environment == "mobile":
        system_instruction += (
            " Use list_apps when needed and pass a package name to open_app."
        )

    load_gemini_api_key()
    with genai.Client() as client:
        bridge = create_bridge(args)
        try:
            screenshot = base64.b64encode(bridge.screenshot()).decode("ascii")
            tool = computer_use_tool(args.environment)
            print(f"Task: {task}")
            print(
                f"Environment: {args.environment} | Model: {args.model} | "
                f"Thinking: {args.thinking_level}"
            )
            interaction = client.interactions.create(
                model=args.model,
                system_instruction=system_instruction,
                input=[
                    {"type": "text", "text": task},
                    {
                        "type": "image",
                        "data": screenshot,
                        "mime_type": "image/png",
                    },
                ],
                tools=[tool],
                generation_config={"thinking_level": args.thinking_level},
            )

            print_usage(interaction)
            for turn in range(1, args.max_turns + 1):
                calls = [
                    step for step in interaction.steps if step.type == "function_call"
                ]
                if not calls:
                    print(f"Agent finished: {output_text(interaction)}")
                    return 0
                print(f"Turn {turn}")
                responses, _ = function_responses(calls, bridge)
                interaction = client.interactions.create(
                    model=args.model,
                    previous_interaction_id=interaction.id,
                    input=responses,
                    tools=[tool],
                    generation_config={"thinking_level": args.thinking_level},
                )
                print_usage(interaction)
            print(
                f"Agent stopped after the {args.max_turns}-turn limit.", file=sys.stderr
            )
            return 2
        finally:
            bridge.close()


def check_environment(args: argparse.Namespace) -> int:
    load_gemini_api_key()
    result: dict[str, Any] = {
        "environment": args.environment,
        "api_key": bool(os.environ.get("GEMINI_API_KEY")),
        "model": args.model,
    }
    ready = result["api_key"]
    try:
        if args.environment == "mobile":
            setup_android_env()
            devices = adb_devices()
            avds = subprocess.run(
                ["emulator", "-list-avds"], capture_output=True, text=True, check=True
            ).stdout.splitlines()
            result.update(
                {
                    "adb_devices": devices,
                    "avds": avds,
                    "selected_avd": args.avd,
                }
            )
            ready = ready and (bool(devices) or args.avd in avds)
        else:
            bridge = MacDesktopBridge(args.display, require_accessibility=False)
            try:
                result.update(bridge.check())
            finally:
                bridge.close()
            ready = ready and bool(
                result["accessibility"] and result["screen_recording"] and result["screenshot"]
            )
            if args.environment == "browser":
                browser_available = (
                    subprocess.run(
                        ["open", "-Ra", args.browser_app],
                        capture_output=True,
                        check=False,
                    ).returncode
                    == 0
                )
                result["browser_app"] = args.browser_app
                result["browser_available"] = browser_available
                ready = ready and browser_available
    except Exception as error:  # noqa: BLE001
        result["error"] = str(error)
        ready = False
    result["ready"] = ready
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if ready else 1


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run Gemini Computer Use against Android or the live macOS session."
    )
    environments = parser.add_mutually_exclusive_group(required=True)
    environments.add_argument(
        "--mobile", dest="environment", action="store_const", const="mobile"
    )
    environments.add_argument(
        "--browser", dest="environment", action="store_const", const="browser"
    )
    environments.add_argument(
        "--desktop", dest="environment", action="store_const", const="desktop"
    )
    parser.add_argument("--model", "-m", default=DEFAULT_MODEL)
    parser.add_argument(
        "--thinking-level",
        "-t",
        choices=["minimal", "low", "medium", "high"],
        default="medium",
    )
    parser.add_argument("--max-turns", type=int, default=100)
    parser.add_argument("--device-id", help="ADB device ID for mobile mode")
    parser.add_argument("--avd", default="AI_Agent_Phone")
    parser.add_argument(
        "--display",
        type=int,
        default=0,
        help="macOS display index, with 0 as the main display",
    )
    parser.add_argument("--browser-app", default="Google Chrome")
    parser.add_argument(
        "--check",
        action="store_true",
        help="check local requirements without calling Gemini or controlling the UI",
    )
    parser.add_argument("task", nargs="*", help="task for the computer-use agent")
    args = parser.parse_args(argv)
    if args.max_turns < 1:
        parser.error("--max-turns must be at least 1")
    if not args.check and not " ".join(args.task).strip():
        parser.error("a task is required unless --check is used")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return check_environment(args) if args.check else run_agent(args)
    except AgentStopped as error:
        print(f"Agent stopped: {error}", file=sys.stderr)
        return 3
    except (RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
