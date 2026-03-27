import asyncio
import json
import logging
import os
import signal
from pathlib import Path
from typing import Any

from browser_use import Agent, Browser, ChatOpenAI
from bullmq import Worker
from dotenv import load_dotenv


ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env")
load_dotenv(Path.cwd() / ".env")


logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("browser-test-worker")


QUEUE_NAME = os.getenv("QUEUE_NAME", "browser-tests")
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "o3")
JOB_TIMEOUT_SECONDS = int(os.getenv("JOB_TIMEOUT_SECONDS", "120"))
AGENT_MAX_STEPS = int(os.getenv("AGENT_MAX_STEPS", "20"))

QA_INSTRUCTIONS = """You are an autonomous QA agent.

* Follow the task step by step
* If login is required, try common credentials provided in the task
* Verify results using both DOM and visual cues
* Stop when the goal is achieved or impossible
"""


def stringify(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return value.strip()

    try:
        return json.dumps(value, ensure_ascii=True, default=str)
    except TypeError:
        return str(value).strip()


def pick_attr(target: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if isinstance(target, dict) and name in target:
            return target[name]
        if hasattr(target, name):
            return getattr(target, name)
    return default


def build_prompt(url: str, task: str) -> str:
    return f"""{QA_INSTRUCTIONS}

Start from this URL: {url}

Task:
{task}

Important:
- Keep the action count low and efficient.
- If authentication is needed, try credentials explicitly mentioned in the task before giving up.
- The final answer must clearly say whether the requested check passed or failed and why.
"""


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


async def run_browser_task(job_data: dict[str, Any]) -> dict[str, Any]:
    url = stringify(job_data.get("url"))
    task = stringify(job_data.get("task"))
    max_steps = int(job_data.get("maxSteps") or AGENT_MAX_STEPS)
    timeout_seconds = int(job_data.get("timeoutSeconds") or JOB_TIMEOUT_SECONDS)

    logs: list[str] = []
    browser = Browser()

    try:
        llm = ChatOpenAI(model=OPENAI_MODEL)
        agent = Agent(
            task=build_prompt(url, task),
            llm=llm,
            browser=browser,
            use_vision=True,
        )

        async def on_step_start(current_agent: Agent) -> None:
            step_number = 1
            step_count_getter = pick_attr(current_agent.history, "number_of_steps")
            if callable(step_count_getter):
                try:
                    step_number = int(step_count_getter()) + 1
                except Exception:
                    step_number = 1
            logs.append(f"Starting step {step_number}")

        async def on_step_end(current_agent: Agent) -> None:
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

        if errors:
            logs.extend([f"Error: {error}" for error in errors])

        return {
            "success": bool(success_value) if success_value is not None else not errors,
            "summary": summary,
            "steps": steps,
            "logs": logs,
            "errors": errors,
            "metadata": {
                "durationSeconds": duration_seconds,
                "finalUrl": final_url,
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
        result = await run_browser_task(job_data)
        result.setdefault("metadata", {})
        result["metadata"]["attemptsMade"] = attempts_made + 1
        logger.info("Job %s finished with success=%s", job_id, result.get("success"))
        return result
    except asyncio.TimeoutError as timeout_error:
        message = f"Job timed out after {job_data.get('timeoutSeconds', JOB_TIMEOUT_SECONDS)} seconds."
        logger.exception("Job %s timed out", job_id)
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


async def main() -> None:
    if not os.getenv("OPENAI_API_KEY"):
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


if __name__ == "__main__":
    asyncio.run(main())
