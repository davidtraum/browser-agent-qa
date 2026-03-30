import asyncio
import base64
import json
import logging
import os
import signal
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from browser_use import Agent, Browser, ChatOpenAI
from bullmq import Worker
from dotenv import load_dotenv
from redis.asyncio import Redis
from codex_cli_adapter import CodexCliChatModel


ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path.cwd() / ".env")


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("browser-test-worker")


def load_additional_ai_context() -> str:
    candidates = [ROOT_DIR / "ai-context.md", Path.cwd() / "ai-context.md"]
    for candidate in candidates:
        try:
            return candidate.read_text(encoding="utf-8").strip()
        except OSError:
            continue
    return ""


QUEUE_NAME = os.getenv("QUEUE_NAME", "browser-tests")
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379")
AI_PROVIDER = os.getenv("AI_PROVIDER", "openai").strip().lower()
if AI_PROVIDER == "codex":
    AI_PROVIDER = "codex_cli"
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "o3")
CODEX_MODEL = os.getenv("CODEX_MODEL", "gpt-5")
CODEX_CLI_PATH = os.getenv("CODEX_CLI_PATH", "codex")
CODEX_CLI_TIMEOUT_SECONDS = int(os.getenv("CODEX_CLI_TIMEOUT_SECONDS", "180"))
JOB_TIMEOUT_SECONDS = int(os.getenv("JOB_TIMEOUT_SECONDS", "120"))
AGENT_MAX_STEPS = int(os.getenv("AGENT_MAX_STEPS", "20"))
CANCELLATION_TTL_SECONDS = 24 * 60 * 60
PROGRESS_HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60
PROGRESS_HISTORY_MAX_ITEMS = 200
redis_client = Redis.from_url(REDIS_URL, decode_responses=True)

QA_INSTRUCTIONS = """You are an autonomous QA agent for the Shopware Administration.

* Follow the task step by step
* If login is required, use the provided Shopware administration credentials first
* Verify results using both DOM and visual cues
* Stop when the goal is achieved or impossible
"""

ADDITIONAL_AI_CONTEXT = load_additional_ai_context()


class TaskCancellationRequested(Exception):
    pass


def stringify(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return value.strip()

    try:
        return json.dumps(value, ensure_ascii=True, default=str)
    except TypeError:
        return str(value).strip()


def compact_text(value: str | None, *, limit: int = 320) -> str:
    text = stringify(value)
    if not text:
        return ""
    single_line = " ".join(text.split())
    if len(single_line) <= limit:
        return single_line
    return f"{single_line[: limit - 3].rstrip()}..."


def pick_attr(target: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(target, dict) and name in target:
            return target[name]
        if hasattr(target, name):
            return getattr(target, name)
    return default


def cancellation_key(job_id: str) -> str:
    return f"{QUEUE_NAME}:cancel:{job_id}"


def progress_history_key(job_id: str) -> str:
    return f"{QUEUE_NAME}:progress:{job_id}"


async def is_cancellation_requested(job_id: str) -> bool:
    try:
        value = await redis_client.get(cancellation_key(job_id))
    except Exception:
        return False
    return value == "1"


async def clear_cancellation_request(job_id: str) -> None:
    try:
        await redis_client.delete(cancellation_key(job_id))
    except Exception as error:
        logger.warning("Failed to clear cancellation flag for job %s: %s", job_id, error)


async def clear_progress_history(job_id: str) -> None:
    try:
        await redis_client.delete(progress_history_key(job_id))
    except Exception as error:
        logger.warning("Failed to clear progress history for job %s: %s", job_id, error)


async def ensure_not_cancelled(job_id: str) -> None:
    if await is_cancellation_requested(job_id):
        raise TaskCancellationRequested("Task cancellation was requested.")


def build_prompt(url: str, task: str, shopware_context: dict[str, Any] | None) -> str:
    branch = stringify((shopware_context or {}).get("branch")) or "unknown"
    admin_username = stringify((shopware_context or {}).get("adminUsername")) or "admin"
    admin_password = stringify((shopware_context or {}).get("adminPassword")) or "shopware"

    additional_context_block = (
        f"\nAdditional context:\n{ADDITIONAL_AI_CONTEXT}\n" if ADDITIONAL_AI_CONTEXT else "\n"
    )

    return f"""{QA_INSTRUCTIONS}{additional_context_block}

Target application: Shopware Administration
Branch under test: {branch}
Start from this URL: {url}
Default login credentials: {admin_username} / {admin_password}

Task:
{task}

Important:
- Keep the action count low and efficient.
- Prefer the Shopware administration credentials above whenever authentication is required.
- The final answer must clearly say whether the requested check passed or failed and why.
"""


def build_llm() -> Any:
    if AI_PROVIDER == "codex_cli":
        return CodexCliChatModel(
            model=CODEX_MODEL,
            cli_path=CODEX_CLI_PATH,
            cwd=str(ROOT_DIR),
            timeout_seconds=CODEX_CLI_TIMEOUT_SECONDS,
        )

    return ChatOpenAI(model=OPENAI_MODEL)


async def capture_current_url(agent: Agent) -> str | None:
    browser_session = getattr(agent, "browser_session", None)
    if browser_session is None:
        return None

    getter = getattr(browser_session, "get_current_page_url", None)
    if getter is None:
        return None

    try:
        return await getter()
    except Exception:
        return None


async def capture_screenshot_data_url(target: Any) -> str | None:
    take_screenshot = getattr(target, "take_screenshot", None)
    if not callable(take_screenshot):
        return None

    try:
        screenshot_bytes = await take_screenshot(format="jpeg", quality=55)
    except Exception:
        return None

    if not screenshot_bytes:
        return None

    encoded = base64.b64encode(screenshot_bytes).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def summarize_actions(agent_output: Any) -> str:
    raw_actions = pick_attr(agent_output, "action", default=[]) or []
    summaries: list[str] = []

    for action in raw_actions:
        action_payload = None
        if hasattr(action, "model_dump"):
            try:
                action_payload = action.model_dump(exclude_none=True)
            except Exception:
                action_payload = None
        elif isinstance(action, dict):
            action_payload = action

        if not action_payload:
            continue

        if len(action_payload) == 1:
            action_name, action_args = next(iter(action_payload.items()))
            if action_args in ({}, None):
                summaries.append(str(action_name))
            else:
                summaries.append(f"{action_name} {compact_text(stringify(action_args), limit=140)}")
        else:
            summaries.append(compact_text(stringify(action_payload), limit=160))

    return " -> ".join(summaries[:4])


def build_agent_reasoning_detail(current_agent: Agent, current_url: str | None = None) -> str:
    state = getattr(current_agent, "state", None)
    agent_output = pick_attr(state, "last_model_output")
    if agent_output is None:
        return ""

    current_state = pick_attr(agent_output, "current_state", default=agent_output)
    detail_parts: list[str] = []

    if current_url:
        detail_parts.append(f"URL: {current_url}")

    evaluation = compact_text(pick_attr(current_state, "evaluation_previous_goal"), limit=220)
    if evaluation:
        detail_parts.append(f"Eval: {evaluation}")

    next_goal = compact_text(pick_attr(current_state, "next_goal"), limit=260)
    if next_goal:
        detail_parts.append(f"Goal: {next_goal}")

    actions_summary = summarize_actions(agent_output)
    if actions_summary:
        detail_parts.append(f"Actions: {actions_summary}")

    memory = compact_text(pick_attr(current_state, "memory"), limit=220)
    if memory:
        detail_parts.append(f"Memory: {memory}")

    return "\n".join(detail_parts)


def normalize_steps(history: Any) -> list[str]:
    steps: list[str] = []

    action_history = pick_attr(history, "action_history")
    if callable(action_history):
        try:
            raw_steps = action_history()
        except Exception:
            raw_steps = []
        for index, entry in enumerate(raw_steps, start=1):
            text = stringify(entry)
            if text:
                steps.append(f"Step {index}: {text}")

    if steps:
        return steps

    action_names = pick_attr(history, "action_names")
    if callable(action_names):
        try:
            raw_names = action_names()
        except Exception:
            raw_names = []
        for index, entry in enumerate(raw_names, start=1):
            text = stringify(entry)
            if text:
                steps.append(f"Step {index}: {text}")

    return steps


def normalize_errors(history: Any) -> list[str]:
    errors: list[str] = []
    errors_getter = pick_attr(history, "errors")
    if callable(errors_getter):
        try:
            raw_errors = errors_getter()
        except Exception:
            raw_errors = []
        for entry in raw_errors:
            text = stringify(entry)
            if text:
                errors.append(text)
    return errors


def infer_reproducibility_gaps(task: str) -> list[str]:
    task_lower = task.lower()
    gaps: list[str] = []

    if "settings" in task_lower and "shop settings" not in task_lower and "profile settings" not in task_lower:
        gaps.append(
            'Specify whether "Settings" means Shop settings, Profile settings, or another settings area.'
        )

    if not any(
        marker in task_lower
        for marker in [
            "customer",
            "order",
            "product",
            "profile",
            "sales channel",
            "category",
            "promotion",
            "rule",
            "plugin",
            "app",
            "theme",
            "cms",
        ]
    ):
        gaps.append("Name the exact page, module, or entity that should be opened during reproduction.")

    if '"' not in task and "'" not in task and not any(char.isdigit() for char in task):
        gaps.append("Include concrete test data such as field values, entity names, or identifiers to use.")

    if not any(
        marker in task_lower
        for marker in [
            "success message",
            "error message",
            "toast",
            "notification",
            "visible",
            "persist",
            "saved",
            "404",
            "validation",
            "disabled",
            "enabled",
        ]
    ):
        gaps.append("Describe the exact observable outcome that proves the bug is reproduced or fixed.")

    if not any(
        marker in task_lower
        for marker in [
            "before",
            "after",
            "precondition",
            "existing",
            "already",
            "feature flag",
            "plugin",
            "extension",
            "permission",
            "role",
        ]
    ):
        gaps.append("Mention any required preconditions such as existing data, permissions, or feature flags.")

    return gaps[:4]


def append_reproducibility_feedback(summary: str, task: str) -> str:
    gaps = infer_reproducibility_gaps(task)
    if not gaps:
        return summary

    bullet_list = "\n".join(f"- {gap}" for gap in gaps)
    return (
        f"{summary}\n\n"
        "Potential missing information for reliable reproduction:\n"
        f"{bullet_list}"
    )


async def publish_execution_progress(
    job: Any,
    *,
    job_id: str,
    message: str,
    detail: str = "",
    step_number: int | None = None,
    sequence: int | None = None,
    screenshot: str | None = None,
) -> None:
    updater = getattr(job, "updateProgress", None)
    if not callable(updater):
        return

    payload: dict[str, Any] = {
        "stage": "execution",
        "message": message,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if detail:
        payload["detail"] = detail
    if step_number is not None:
        payload["stepNumber"] = step_number
    if sequence is not None:
        payload["sequence"] = sequence
    if screenshot:
        payload["screenshot"] = screenshot

    try:
        await updater(payload)
    except Exception as progress_error:
        logger.warning("Failed to publish job progress: %s", progress_error)

    try:
        history_key = progress_history_key(job_id)
        await redis_client.rpush(history_key, json.dumps(payload))
        await redis_client.ltrim(history_key, -PROGRESS_HISTORY_MAX_ITEMS, -1)
        await redis_client.expire(history_key, PROGRESS_HISTORY_TTL_SECONDS)
    except Exception as progress_error:
        logger.warning("Failed to append job progress history: %s", progress_error)


async def run_browser_task(job: Any, job_data: dict[str, Any], job_id: str) -> dict[str, Any]:
    url = stringify(job_data.get("url"))
    task = stringify(job_data.get("task"))
    shopware_context = pick_attr(job_data, "shopware", default={}) or {}
    max_steps = int(job_data.get("maxSteps") or AGENT_MAX_STEPS)
    timeout_seconds = int(job_data.get("timeoutSeconds") or JOB_TIMEOUT_SECONDS)

    logs: list[str] = []
    browser = Browser()
    progress_sequence = 1

    async def emit_progress(
        message: str,
        detail: str = "",
        step_number: int | None = None,
        screenshot: str | None = None,
    ) -> None:
        nonlocal progress_sequence
        progress_sequence += 1
        await publish_execution_progress(
            job,
            job_id=job_id,
            message=message,
            detail=detail,
            step_number=step_number,
            sequence=progress_sequence,
            screenshot=screenshot,
        )

    try:
        await ensure_not_cancelled(job_id)
        llm = build_llm()
        agent = Agent(
            task=build_prompt(url, task, shopware_context),
            llm=llm,
            browser=browser,
            use_vision=True,
        )

        await emit_progress(
            "Launching the browser agent.",
            detail=f"Opening {url}",
        )

        async def on_step_start(current_agent: Agent) -> None:
            await ensure_not_cancelled(job_id)
            step_number = 1
            step_count_getter = pick_attr(current_agent.history, "number_of_steps")
            if callable(step_count_getter):
                try:
                    step_number = int(step_count_getter()) + 1
                except Exception:
                    step_number = 1
            logs.append(f"Starting step {step_number}")
            current_url = await capture_current_url(current_agent)
            screenshot = await capture_screenshot_data_url(current_agent.browser_session)
            detail = build_agent_reasoning_detail(current_agent, current_url)
            if not detail:
                detail = f"Inspecting page state before step {step_number}."
                if current_url:
                    detail = f"{detail} Current URL: {current_url}"
            await emit_progress(
                f"Running browser step {step_number}.",
                detail=detail,
                step_number=step_number,
                screenshot=screenshot,
            )

        async def on_step_end(current_agent: Agent) -> None:
            await ensure_not_cancelled(job_id)
            step_count = pick_attr(current_agent.history, "number_of_steps")
            current_url = await capture_current_url(current_agent)
            step_label = "Completed step"
            if callable(step_count):
                try:
                    step_label = f"Completed step {int(step_count())}"
                except Exception:
                    step_label = "Completed step"

            last_action_getter = pick_attr(current_agent.history, "last_action")
            last_action = ""
            if callable(last_action_getter):
                try:
                    last_action = stringify(last_action_getter())
                except Exception:
                    last_action = ""

            if current_url:
                logs.append(f"{step_label} at {current_url} {last_action}".strip())
            else:
                logs.append(f"{step_label} {last_action}".strip())

            progress_detail_parts = []
            if last_action:
                progress_detail_parts.append(f"Observed action result: {compact_text(last_action, limit=220)}")
            reasoning_detail = build_agent_reasoning_detail(current_agent, current_url)
            if reasoning_detail:
                progress_detail_parts.append(reasoning_detail)
            screenshot = await capture_screenshot_data_url(current_agent.browser_session)

            await emit_progress(
                step_label,
                detail="\n".join(progress_detail_parts),
                step_number=int(step_count()) if callable(step_count) else None,
                screenshot=screenshot,
            )

        logger.info("Running browser task for %s", url)
        history = await asyncio.wait_for(
            agent.run(
                max_steps=max_steps,
                on_step_start=on_step_start,
                on_step_end=on_step_end,
            ),
            timeout=timeout_seconds,
        )

        steps = normalize_steps(history)
        errors = normalize_errors(history)
        final_result_getter = pick_attr(history, "final_result")
        final_result = final_result_getter() if callable(final_result_getter) else ""
        success_getter = pick_attr(history, "is_successful")
        success_value = success_getter() if callable(success_getter) else None
        duration_getter = pick_attr(history, "total_duration_seconds")
        duration_seconds = duration_getter() if callable(duration_getter) else None
        final_url = None
        urls_getter = pick_attr(history, "urls")
        if callable(urls_getter):
            try:
                visited_urls = urls_getter()
                if visited_urls:
                    final_url = stringify(visited_urls[-1])
            except Exception:
                final_url = None

        summary = stringify(final_result) or "The agent finished without a final summary."
        success = bool(success_value) if success_value is not None else not errors
        step_limit_reached = bool(steps) and len(steps) >= max_steps and not success

        if step_limit_reached:
            summary = append_reproducibility_feedback(summary, task)

        if errors:
            logs.extend([f"Error: {error}" for error in errors])

        if step_limit_reached:
            logs.append("The agent reached the configured step limit before confidently completing the goal.")
            for gap in infer_reproducibility_gaps(task):
                logs.append(f"Missing reproducibility detail: {gap}")

        await emit_progress(
            "Browser run finished.",
            detail=summary,
            step_number=len(steps) if steps else None,
        )

        return {
            "success": success,
            "summary": summary,
            "steps": steps,
            "logs": logs,
            "errors": errors,
            "metadata": {
                "durationSeconds": duration_seconds,
                "finalUrl": final_url,
                "branch": stringify((shopware_context or {}).get("branch")) or None,
                "stepLimitReached": step_limit_reached,
            },
        }
    finally:
        close_method = getattr(browser, "close", None)
        if callable(close_method):
            try:
                result = close_method()
                if asyncio.iscoroutine(result):
                    await result
            except Exception as close_error:
                logger.warning("Failed to close browser cleanly: %s", close_error)


async def process_job(job: Any, _job_token: str) -> dict[str, Any]:
    attempts_made = int(pick_attr(job, "attemptsMade", "attempts_made", default=0) or 0)
    opts = pick_attr(job, "opts", default={}) or {}
    max_attempts = int(pick_attr(opts, "attempts", default=1) or 1)
    job_id = stringify(pick_attr(job, "id", default="unknown"))
    job_data = pick_attr(job, "data", default={}) or {}

    logger.info("Picked up job %s (attempt %s/%s)", job_id, attempts_made + 1, max_attempts)

    try:
        await ensure_not_cancelled(job_id)
        await clear_progress_history(job_id)
        await publish_execution_progress(
            job,
            job_id=job_id,
            message="Worker picked up the browser run.",
            detail=f"Attempt {attempts_made + 1} of {max_attempts}",
            sequence=1,
        )
        result = await run_browser_task(job, job_data, job_id)
        result.setdefault("metadata", {})
        result["metadata"]["attemptsMade"] = attempts_made + 1
        logger.info("Job %s finished with success=%s", job_id, result.get("success"))
        return result
    except TaskCancellationRequested as cancellation_error:
        message = stringify(cancellation_error) or "Task cancellation was requested."
        logger.info("Job %s was cancelled", job_id)
        await publish_execution_progress(
            job,
            job_id=job_id,
            message="Browser run cancelled.",
            detail=message,
            sequence=999996,
        )
        return {
            "success": False,
            "summary": message,
            "steps": [],
            "logs": [message],
            "errors": [message],
            "metadata": {
                "attemptsMade": attempts_made + 1,
                "cancelled": True,
            },
        }
    except asyncio.TimeoutError as timeout_error:
        message = f"Job timed out after {job_data.get('timeoutSeconds', JOB_TIMEOUT_SECONDS)} seconds."
        logger.exception("Job %s timed out", job_id)
        await publish_execution_progress(
            job,
            job_id=job_id,
            message="Browser run timed out.",
            detail=message,
            sequence=999997,
        )
        if attempts_made + 1 >= max_attempts:
            return {
                "success": False,
                "summary": message,
                "steps": [],
                "logs": [message, str(timeout_error)],
                "errors": [message],
                "metadata": {
                    "attemptsMade": attempts_made + 1,
                },
            }
        raise RuntimeError(message) from timeout_error
    except Exception as error:
        message = f"Browser task failed: {error}"
        logger.exception("Job %s failed", job_id)
        await publish_execution_progress(
            job,
            job_id=job_id,
            message="Browser run failed.",
            detail=stringify(error),
            sequence=999998,
        )
        if attempts_made + 1 >= max_attempts:
            return {
                "success": False,
                "summary": message,
                "steps": [],
                "logs": [message],
                "errors": [stringify(error)],
                "metadata": {
                    "attemptsMade": attempts_made + 1,
                },
            }
        raise
    finally:
        await clear_cancellation_request(job_id)


async def main() -> None:
    if AI_PROVIDER == "openai" and not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required to start the worker.")

    shutdown_event = asyncio.Event()

    def signal_handler(_signal_number: int, _frame: Any) -> None:
        logger.info("Shutdown signal received")
        shutdown_event.set()

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    logger.info("Starting worker for queue %s", QUEUE_NAME)
    worker = Worker(
        QUEUE_NAME,
        process_job,
        {
            "connection": REDIS_URL,
        },
    )

    await shutdown_event.wait()
    logger.info("Closing worker")
    await worker.close()
    await redis_client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
