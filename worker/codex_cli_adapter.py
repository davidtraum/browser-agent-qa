from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from browser_use.llm.messages import BaseMessage, ContentPartImageParam
from browser_use.llm.views import ChatInvokeCompletion
from pydantic import TypeAdapter


def _extract_message_text(message: BaseMessage) -> str:
    text = getattr(message, "text", "")
    if isinstance(text, str):
        return text.strip()
    return str(text).strip()


def _materialize_data_url(image_url: str, directory: Path, index: int) -> Path | None:
    if not image_url.startswith("data:"):
        return None

    match = re.match(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$", image_url, re.DOTALL)
    if not match:
        return None

    mime_type = match.group("mime")
    extension = mimetypes.guess_extension(mime_type) or ".png"
    target = directory / f"image-{index}{extension}"
    target.write_bytes(base64.b64decode(match.group("data")))
    return target


def _collect_images(messages: list[BaseMessage], directory: Path) -> list[Path]:
    image_paths: list[Path] = []
    image_index = 0

    for message in messages:
        content = getattr(message, "content", None)
        if not isinstance(content, list):
            continue

        for part in content:
            if not isinstance(part, ContentPartImageParam):
                continue

            image_index += 1
            image_path = _materialize_data_url(part.image_url.url, directory, image_index)
            if image_path is not None:
                image_paths.append(image_path)

    return image_paths


def _render_prompt(messages: list[BaseMessage], image_count: int, output_format: type[Any] | None) -> str:
    transcript: list[str] = []

    for message in messages:
        role = getattr(message, "role", "user").upper()
        text = _extract_message_text(message)
        if text:
            transcript.append(f"{role}:\n{text}")
        else:
            transcript.append(f"{role}:\n[No text content]")

    prompt_parts = [
        "You are fulfilling a browser-use LLM call through Codex CLI.",
        "Use the conversation transcript below as the complete context for this single response.",
    ]

    if image_count:
        prompt_parts.append(
            f"There are {image_count} attached image(s) from the browser state. Use them as visual context."
        )

    if output_format is not None:
        prompt_parts.append("Return only JSON that matches the provided output schema exactly.")

    prompt_parts.extend(["", "\n\n".join(transcript)])
    return "\n".join(prompt_parts).strip()


def _extract_json_payload(raw_output: str) -> Any:
    trimmed = raw_output.strip()
    if not trimmed:
        raise ValueError("Codex CLI returned an empty response.")

    candidates = [
        trimmed,
        re.sub(r"^```json\s*", "", trimmed, flags=re.IGNORECASE).removesuffix("```").strip(),
    ]

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue

    object_match = re.search(r"\{.*\}", trimmed, flags=re.DOTALL)
    if object_match:
        return json.loads(object_match.group(0))

    raise ValueError(f"Codex CLI did not return valid JSON.\n{trimmed}")


def _sanitize_output_schema(value: Any) -> Any:
    if isinstance(value, dict):
        sanitized = {key: _sanitize_output_schema(nested) for key, nested in value.items()}
        if "$ref" in sanitized:
            return {"$ref": sanitized["$ref"]}
        if "properties" in sanitized and isinstance(sanitized["properties"], dict):
            sanitized["additionalProperties"] = False
            sanitized["required"] = list(sanitized["properties"].keys())
        return sanitized

    if isinstance(value, list):
        return [_sanitize_output_schema(item) for item in value]

    return value


@dataclass
class CodexCliChatModel:
    model: str
    cli_path: str = "codex"
    cwd: str = "."
    timeout_seconds: int = 180

    @property
    def provider(self) -> str:
        return "codex_cli"

    @property
    def name(self) -> str:
        return self.model

    @property
    def model_name(self) -> str:
        return self.model

    async def ainvoke(
        self, messages: list[BaseMessage], output_format: type[Any] | None = None, **_: Any
    ) -> ChatInvokeCompletion[Any]:
        with tempfile.TemporaryDirectory(prefix="browser-agent-codex-") as temp_dir_raw:
            temp_dir = Path(temp_dir_raw)
            output_path = temp_dir / "last-message.txt"
            schema_path = temp_dir / "schema.json"
            image_paths = _collect_images(messages, temp_dir)

            if output_format is not None:
                schema = _sanitize_output_schema(TypeAdapter(output_format).json_schema())
                schema_path.write_text(json.dumps(schema, indent=2), encoding="utf-8")

            prompt = _render_prompt(messages, len(image_paths), output_format)
            cmd = [
                self.cli_path,
                "exec",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--cd",
                self.cwd,
                "--model",
                self.model,
                "--output-last-message",
                str(output_path),
            ]

            if output_format is not None:
                cmd.extend(["--output-schema", str(schema_path)])

            for image_path in image_paths:
                cmd.extend(["--image", str(image_path)])

            cmd.append("-")

            try:
                completed = subprocess.run(
                    cmd,
                    input=prompt,
                    capture_output=True,
                    text=True,
                    cwd=self.cwd,
                    env=os.environ.copy(),
                    timeout=self.timeout_seconds,
                    check=False,
                )
            except FileNotFoundError as error:
                raise RuntimeError(
                    f'Codex CLI was not found at "{self.cli_path}". Install it with `npm i -g @openai/codex` or set CODEX_CLI_PATH.'
                ) from error
            except subprocess.TimeoutExpired as error:
                raise RuntimeError(f"codex exec timed out after {self.timeout_seconds} seconds.") from error

            if completed.returncode != 0:
                details = [completed.stdout.strip(), completed.stderr.strip()]
                raise RuntimeError(
                    "\n".join(
                        part for part in [f"codex exec exited with code {completed.returncode}.", *details] if part
                    )
                )

            raw_output = output_path.read_text(encoding="utf-8").strip()

            if output_format is None:
                return ChatInvokeCompletion(
                    completion=raw_output,
                    usage=None,
                    stop_reason="end_turn",
                )

            parsed_output = _extract_json_payload(raw_output)
            validated_output = TypeAdapter(output_format).validate_python(parsed_output)
            return ChatInvokeCompletion(
                completion=validated_output,
                usage=None,
                stop_reason="end_turn",
            )
