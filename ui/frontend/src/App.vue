<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { clearFinishedTasks, fetchBranches, fetchTaskStatus, fetchTasks, stopTask, streamIssueRun } from './lib/stream';
import type {
  FeedEvent,
  ManagedTaskList,
  ManagedTaskSummary,
  ProgressSnapshot,
  ShopwareBranchOption,
  TaskStatusResponse,
  TimelineItem,
} from './types';

const issueUrl = ref('');
const branch = ref('trunk');
const defaultBranch = ref('trunk');
const branchOptions = ref<ShopwareBranchOption[]>([]);
const isRunning = ref(false);
const errorMessage = ref('');
const currentJobId = ref('');
const currentStatus = ref('idle');
const issueTitle = ref('');
const issueMeta = ref('');
const currentBranch = ref('trunk');
const currentAdminUrl = ref('');
const currentActivity = ref('Waiting for a new issue check.');
const planSummary = ref('');
const generatedTask = ref('');
const generatedSteps = ref<string[]>([]);
const resultSummary = ref('');
const resultSteps = ref<string[]>([]);
const resultLogs = ref<string[]>([]);
const resultSuccess = ref<boolean | null>(null);
const feedItems = ref<TimelineItem[]>([]);
const submittedIssueUrl = ref('');
const hasInitializedBranch = ref(false);
const chatFeed = ref<HTMLElement | null>(null);
const expandedScreenshot = ref<{ src: string; label: string } | null>(null);
const managedTasks = ref<ManagedTaskList>({ running: [], pending: [], recent: [] });
const selectedTaskId = ref('');
const isLoadingTasks = ref(false);
const stoppingTaskId = ref('');
const isClearingFinished = ref(false);
const taskActionMessage = ref('');
const taskRefreshHandle = ref<number | null>(null);
const selectedTaskRefreshHandle = ref<number | null>(null);
const selectedTaskResultSignature = ref('');
const selectedTaskLastSequence = ref(0);

let activeController: AbortController | null = null;

const statusLabel = computed(() => {
  if (currentStatus.value === 'idle') {
    return 'Waiting';
  }

  return currentStatus.value;
});

const addFeedItem = (item: Omit<TimelineItem, 'id'>) => {
  feedItems.value.push({
    id: crypto.randomUUID(),
    ...item,
  });
};

const timelineItemFromEvent = (event: FeedEvent): Omit<TimelineItem, 'id'> | null => {
  switch (event.type) {
    case 'accepted':
      return {
        label: 'Request accepted',
        detail: `Preparing Shopware branch ${event.branch} for ${event.issueUrl}.`,
        tone: 'info',
      };
    case 'progress':
      return {
        label: formatProgressLabel(event.stage),
        detail: event.detail ? `${event.message} ${event.detail}` : event.message,
        tone: event.stage === 'ready' || event.stage === 'queue' ? 'success' : 'info',
        screenshot: event.screenshot,
      };
    case 'issue':
      return {
        label: 'Issue analyzed',
        detail: event.issue.title,
        tone: 'info',
      };
    case 'plan':
      return {
        label: 'Test plan ready',
        detail: event.summary,
        tone: 'info',
      };
    case 'job':
      return {
        label: 'Worker queued',
        detail: `Job ${event.jobId} is now testing Shopware Administration on branch ${event.branch}.`,
        tone: 'info',
      };
    case 'status':
      return {
        label: 'Status update',
        detail: `${event.status} · attempt ${event.attemptsMade}`,
        tone: event.status === 'completed' ? 'success' : 'warning',
      };
    case 'result':
      return {
        label: event.result.success ? 'Run completed' : 'Run failed',
        detail: event.result.summary,
        tone: event.result.success ? 'success' : 'danger',
      };
    case 'error':
      return {
        label: 'Error',
        detail: event.message,
        tone: 'danger',
      };
    default:
      return null;
  }
};

const formatExecutionDetail = (detail: string): string => {
  const normalizedLines = detail
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalizedLines.length === 0) {
    return '';
  }

  const formattedLines = normalizedLines.map((line) => {
    if (line.startsWith('Observed action result:')) {
      return `🧾 ${line}`;
    }

    if (line.startsWith('URL:')) {
      return `🌐 ${line}`;
    }

    if (line.startsWith('Eval:')) {
      return `✅ ${line}`;
    }

    if (line.startsWith('Goal:')) {
      return `🎯 ${line}`;
    }

    if (line.startsWith('Actions:')) {
      return `🛠 ${line}`;
    }

    if (line.startsWith('Memory:')) {
      return `🧠 ${line}`;
    }

    return `• ${line}`;
  });

  return formattedLines.join('\n\n');
};

const formatProgressCopy = (progress: ProgressSnapshot): string => {
  if (!progress.detail) {
    return progress.message;
  }

  if (progress.stage !== 'execution') {
    return `${progress.message}\n\n${progress.detail}`;
  }

  return `${progress.message}\n\n${formatExecutionDetail(progress.detail)}`;
};

const findManagedTask = (taskId: string): ManagedTaskSummary | undefined =>
  [...managedTasks.value.running, ...managedTasks.value.pending, ...managedTasks.value.recent].find(
    (task) => task.jobId === taskId,
  );

const describeTaskState = (task: ManagedTaskSummary) => {
  if (task.status === 'waiting' || task.status === 'prioritized' || task.status === 'delayed') {
    return {
      icon: '…',
      label: 'Wartet',
      className: 'waiting',
    };
  }

  if (
    task.status === 'active' ||
    task.status === 'cancelling' ||
    (task.status === 'completed' && typeof task.resultSuccess !== 'boolean')
  ) {
    if (task.progress?.stage === 'execution') {
      return {
        icon: '▶',
        label: 'Wird ausgefuhrt',
        className: 'running',
      };
    }

    return {
      icon: '◌',
      label: 'Wird vorbereitet',
      className: 'preparing',
    };
  }

  if (task.resultSuccess === true) {
    return {
      icon: '✓',
      label: 'Pass',
      className: 'passed',
    };
  }

  return {
    icon: '✕',
    label: 'No pass',
    className: 'failed',
  };
};

const resetSelectedTaskSignatures = () => {
  selectedTaskResultSignature.value = '';
  selectedTaskLastSequence.value = 0;
};

const scrollFeedToBottom = (behavior: ScrollBehavior = 'smooth') => {
  void nextTick(() => {
    if (!chatFeed.value) {
      return;
    }

    chatFeed.value.scrollTo({
      top: chatFeed.value.scrollHeight,
      behavior,
    });
  });
};

const formatProgressLabel = (
  stage:
    | 'issue'
    | 'planning'
    | 'branch'
    | 'checkout'
    | 'pull'
    | 'docker'
    | 'setup'
    | 'watch'
    | 'ready'
    | 'queue'
    | 'execution',
) => {
  switch (stage) {
    case 'issue':
      return 'Issue fetch';
    case 'planning':
      return 'Planning';
    case 'branch':
      return 'Branch check';
    case 'checkout':
      return 'Checkout';
    case 'pull':
      return 'Repository sync';
    case 'docker':
      return 'Docker';
    case 'setup':
      return 'Composer setup';
    case 'watch':
      return 'Admin watcher';
    case 'ready':
      return 'Readiness';
    case 'queue':
      return 'Queue';
    case 'execution':
      return 'Browser action';
    default:
      return 'Progress';
  }
};

const resetState = () => {
  errorMessage.value = '';
  currentJobId.value = '';
  currentStatus.value = 'starting';
  issueTitle.value = '';
  issueMeta.value = '';
  currentBranch.value = branch.value.trim() || defaultBranch.value;
  currentAdminUrl.value = '';
  currentActivity.value = 'Waiting for the service to accept the request.';
  planSummary.value = '';
  generatedTask.value = '';
  generatedSteps.value = [];
  resultSummary.value = '';
  resultSteps.value = [];
  resultLogs.value = [];
  resultSuccess.value = null;
  feedItems.value = [];
  resetSelectedTaskSignatures();
};

const returnToStartScreen = () => {
  activeController?.abort();
  activeController = null;
  isRunning.value = false;
  errorMessage.value = '';
  currentJobId.value = '';
  currentStatus.value = 'idle';
  issueTitle.value = '';
  issueMeta.value = '';
  currentBranch.value = branch.value.trim() || defaultBranch.value;
  currentAdminUrl.value = '';
  currentActivity.value = 'Waiting for a new issue check.';
  planSummary.value = '';
  generatedTask.value = '';
  generatedSteps.value = [];
  resultSummary.value = '';
  resultSteps.value = [];
  resultLogs.value = [];
  resultSuccess.value = null;
  feedItems.value = [];
  submittedIssueUrl.value = '';
  selectedTaskId.value = '';
  resetSelectedTaskSignatures();
};

const submittedBranchLabel = computed(() => currentBranch.value || branch.value.trim() || defaultBranch.value);

const outcomeLabel = computed(() => {
  if (resultSuccess.value === true) {
    return 'Passed';
  }

  if (resultSuccess.value === false || errorMessage.value) {
    return 'Needs attention';
  }

  return 'Pending';
});

const visibleTaskCount = computed(
  () => managedTasks.value.running.length + managedTasks.value.pending.length + managedTasks.value.recent.length,
);

const hasTasks = computed(() => visibleTaskCount.value > 0);

watch(
  () => [feedItems.value.length, submittedIssueUrl.value, isRunning.value] as const,
  ([feedCount], previousValue) => {
    const previousFeedCount = previousValue?.[0] ?? 0;
    scrollFeedToBottom(feedCount > previousFeedCount ? 'smooth' : 'auto');
  },
);

const applyEvent = (event: FeedEvent) => {
  switch (event.type) {
    case 'accepted':
      currentActivity.value = `Preparing Shopware branch ${event.branch}.`;
      break;
    case 'progress':
      currentActivity.value = event.detail ? `${event.message} ${event.detail}` : event.message;
      break;
    case 'issue':
      issueTitle.value = event.issue.title;
      issueMeta.value = `${event.issue.repository} · #${event.issue.number}`;
      break;
    case 'plan':
      planSummary.value = event.summary;
      generatedTask.value = event.generatedTask;
      generatedSteps.value = event.generatedSteps;
      break;
    case 'job':
      currentJobId.value = event.jobId;
      selectedTaskId.value = event.jobId;
      resetSelectedTaskSignatures();
      currentBranch.value = event.branch;
      currentAdminUrl.value = event.adminUrl;
      currentActivity.value = `Worker ${event.jobId} is running against Shopware branch ${event.branch}.`;
      break;
    case 'status':
      currentStatus.value = event.status;
      currentActivity.value = `Worker status is now ${event.status} on attempt ${event.attemptsMade}.`;
      break;
    case 'result':
      resultSuccess.value = event.result.success;
      resultSummary.value = event.result.summary;
      resultSteps.value = event.result.steps;
      resultLogs.value = event.result.logs;
      currentStatus.value = event.result.success ? 'completed' : 'failed';
      currentActivity.value = event.result.summary;
      break;
    case 'error':
      errorMessage.value = event.message;
      currentStatus.value = 'failed';
      currentActivity.value = event.message;
      break;
  }

  const timelineItem = timelineItemFromEvent(event);
  if (timelineItem) {
    addFeedItem(timelineItem);
  }
};

const applyTaskSnapshot = (
  task: ManagedTaskSummary,
  status: TaskStatusResponse,
  options?: {
    replaceFeed?: boolean;
    appendProgress?: boolean;
  },
) => {
  const replaceFeed = options?.replaceFeed === true;
  const appendProgress = options?.appendProgress === true;
  const issueLabel = task.issueTitle || `Task ${task.jobId}`;
  const resultSignature = status.result ? JSON.stringify(status.result) : '';
  const historyEvents = status.historyEvents ?? [];
  const progressEvents = status.progressEvents ?? (status.progress ? [status.progress] : []);
  const nextEvents = progressEvents.filter((event) => (event.sequence ?? 0) > selectedTaskLastSequence.value);
  const latestProgressEvent = progressEvents.at(-1) ?? status.progress;

  selectedTaskId.value = task.jobId;
  currentJobId.value = task.jobId;
  currentStatus.value = status.status;
  currentBranch.value = task.branch || defaultBranch.value;
  currentAdminUrl.value = task.adminUrl || '';
  submittedIssueUrl.value = task.issueUrl || '';
  issueTitle.value = issueLabel;
  issueMeta.value = task.repository || 'Shopware task';
  taskActionMessage.value = '';

  if (status.result) {
    resultSuccess.value = status.result.success;
    resultSummary.value = status.result.summary;
    resultSteps.value = status.result.steps;
    resultLogs.value = status.result.logs;
    currentActivity.value = status.result.summary;
  } else {
    resultSuccess.value = null;
    resultSummary.value = '';
    resultSteps.value = [];
    resultLogs.value = [];
    currentActivity.value = latestProgressEvent
      ? formatProgressCopy(latestProgressEvent)
      : `${status.status} · attempt ${status.attemptsMade}`;
  }

  if (replaceFeed) {
    feedItems.value = [];
    for (const historyEvent of historyEvents) {
      const timelineItem = timelineItemFromEvent(historyEvent);
      if (timelineItem) {
        addFeedItem(timelineItem);
      }
    }
    if (!historyEvents.some((event) => event.type === 'status')) {
      addFeedItem({
        label: 'Status update',
        detail: `${status.status} · attempt ${status.attemptsMade}`,
        tone: status.status === 'failed' ? 'danger' : status.status === 'cancelled' ? 'warning' : 'info',
      });
    }
    for (const progressEvent of progressEvents) {
      addFeedItem({
        label: formatProgressLabel(progressEvent.stage),
        detail: formatProgressCopy(progressEvent),
        tone: status.status === 'cancelled' ? 'warning' : 'info',
        screenshot: progressEvent.screenshot,
      });
    }
    if (status.result && !historyEvents.some((event) => event.type === 'result')) {
      addFeedItem({
        label: status.status === 'cancelled' ? 'Run cancelled' : status.result.success ? 'Run completed' : 'Run failed',
        detail: status.result.summary,
        tone: status.status === 'cancelled' ? 'warning' : status.result.success ? 'success' : 'danger',
      });
    }
  } else if (appendProgress && nextEvents.length > 0) {
    for (const progressEvent of nextEvents) {
      addFeedItem({
        label: formatProgressLabel(progressEvent.stage),
        detail: formatProgressCopy(progressEvent),
        tone: status.status === 'cancelled' ? 'warning' : 'info',
        screenshot: progressEvent.screenshot,
      });
    }
  }

  if (!replaceFeed && status.result && resultSignature && resultSignature !== selectedTaskResultSignature.value) {
    addFeedItem({
      label: status.status === 'cancelled' ? 'Run cancelled' : status.result.success ? 'Run completed' : 'Run failed',
      detail: status.result.summary,
      tone: status.status === 'cancelled' ? 'warning' : status.result.success ? 'success' : 'danger',
    });
  }

  selectedTaskResultSignature.value = resultSignature;
  selectedTaskLastSequence.value = progressEvents.reduce(
    (highestSequence, progressEvent) => Math.max(highestSequence, progressEvent.sequence ?? 0),
    selectedTaskLastSequence.value,
  );
};

const loadTasks = async (options?: { silent?: boolean }) => {
  if (!options?.silent) {
    isLoadingTasks.value = true;
  }

  try {
    managedTasks.value = await fetchTasks();
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    isLoadingTasks.value = false;
  }
};

const syncSelectedTask = async (taskId: string, options?: { replaceFeed?: boolean; appendProgress?: boolean }) => {
  const task = findManagedTask(taskId) ?? {
    jobId: taskId,
    status: currentStatus.value,
    attemptsMade: 0,
    branch: currentBranch.value,
    issueUrl: submittedIssueUrl.value,
    issueTitle: issueTitle.value,
    repository: issueMeta.value,
    adminUrl: currentAdminUrl.value,
  };

  const status = await fetchTaskStatus(taskId);
  applyTaskSnapshot(task, status, options);
};

const selectTask = async (taskId: string) => {
  if (selectedTaskId.value !== taskId) {
    resetSelectedTaskSignatures();
  }

  try {
    await syncSelectedTask(taskId, { replaceFeed: true });
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    addFeedItem({
      label: 'Task switch failed',
      detail: errorMessage.value,
      tone: 'danger',
    });
  }
};

const stopManagedTaskFromUi = async (taskId: string) => {
  stoppingTaskId.value = taskId;

  try {
    const result = await stopTask(taskId);
    taskActionMessage.value = result.message;
    const isCurrentTask = selectedTaskId.value === taskId || currentJobId.value === taskId;

    if (!isCurrentTask) {
      addFeedItem({
        label: result.action === 'removed' ? 'Task removed' : 'Task stopping',
        detail: result.message,
        tone: result.action === 'removed' ? 'warning' : 'info',
      });
    }

    await loadTasks({ silent: true });

    if (isCurrentTask) {
      returnToStartScreen();
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    stoppingTaskId.value = '';
  }
};

const clearFinishedTasksFromUi = async () => {
  isClearingFinished.value = true;

  try {
    const result = await clearFinishedTasks();
    taskActionMessage.value = result.message;
    const removedCurrentTask =
      selectedTaskId.value !== '' && result.clearedJobIds.includes(selectedTaskId.value);

    await loadTasks({ silent: true });

    if (removedCurrentTask) {
      returnToStartScreen();
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    isClearingFinished.value = false;
  }
};

const submitIssue = async () => {
  const trimmed = issueUrl.value.trim();
  if (!trimmed || isRunning.value) {
    return;
  }

  activeController?.abort();
  activeController = new AbortController();
  isRunning.value = true;
  submittedIssueUrl.value = trimmed;
  resetState();

  try {
    await streamIssueRun(
      trimmed,
      branch.value.trim() || defaultBranch.value,
      (event) => {
        applyEvent(event);
      },
      activeController.signal,
    );
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      errorMessage.value = error instanceof Error ? error.message : String(error);
      addFeedItem({
        label: 'Connection failed',
        detail: errorMessage.value,
        tone: 'danger',
      });
    }
  } finally {
    isRunning.value = false;
    await loadTasks({ silent: true });
  }
};

const openScreenshot = (src: string, label: string) => {
  expandedScreenshot.value = { src, label };
};

const closeScreenshot = () => {
  expandedScreenshot.value = null;
};

const handleKeydown = async (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    await submitIssue();
  }
};

const loadBranches = async (query?: string, options?: { syncBranch?: boolean }) => {
  try {
    const response = await fetchBranches(query);
    defaultBranch.value = response.defaultBranch;
    if (options?.syncBranch && !hasInitializedBranch.value) {
      branch.value = response.defaultBranch;
      hasInitializedBranch.value = true;
    }
    branchOptions.value = response.branches;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
  }
};

onMounted(async () => {
  await loadBranches(undefined, { syncBranch: true });
  await loadTasks();
  scrollFeedToBottom('auto');
  taskRefreshHandle.value = window.setInterval(() => {
    void loadTasks({ silent: true });
  }, 4000);
  selectedTaskRefreshHandle.value = window.setInterval(() => {
    if (!selectedTaskId.value || isRunning.value) {
      return;
    }

    void syncSelectedTask(selectedTaskId.value, { appendProgress: true }).catch((error) => {
      errorMessage.value = error instanceof Error ? error.message : String(error);
    });
  }, 3000);
});

onUnmounted(() => {
  activeController?.abort();
  if (taskRefreshHandle.value !== null) {
    window.clearInterval(taskRefreshHandle.value);
  }
  if (selectedTaskRefreshHandle.value !== null) {
    window.clearInterval(selectedTaskRefreshHandle.value);
  }
});
</script>

<template>
  <div class="shell">
    <section class="workspace">
      <article class="chat-panel glass-card">
        <div class="chat-header">
          <div>
            <p class="panel-kicker">Shopware QA Copilot</p>
            <h2>{{ issueTitle || 'Start with a GitHub issue URL' }}</h2>
            <p class="muted">
              {{
                issueMeta ||
                'Paste a Shopware issue, pick a branch, and the feed will narrate planning, provisioning, and execution.'
              }}
            </p>
          </div>
          <div class="chat-header-meta">
            <span class="status-pill" :data-state="currentStatus">{{ statusLabel }}</span>
            <span class="counter">{{ feedItems.length }} updates</span>
          </div>
        </div>

        <div ref="chatFeed" class="chat-feed">
          <div class="chat-message user-message">
            <div class="message-avatar">You</div>
            <div class="message-bubble user-bubble">
              <p class="message-label">Issue request</p>
              <p class="message-body">
                {{
                  submittedIssueUrl ||
                  'No issue submitted yet. Paste a GitHub issue URL below and hit Enter to kick off the run.'
                }}
              </p>
              <div class="message-tags">
                <span class="tag">{{ submittedBranchLabel }}</span>
                <span class="tag ghost">{{ isRunning ? 'Run in progress' : 'Waiting to start' }}</span>
              </div>
            </div>
          </div>

          <div v-if="!feedItems.length" class="chat-message assistant-message">
            <div class="message-avatar assistant">QA</div>
            <div class="message-bubble assistant-bubble">
              <p class="message-label">Live feed ready</p>
              <p class="message-body">
                I will stream issue analysis, the generated test plan, Shopware provisioning, and the browser run here
                as a readable conversation.
              </p>
            </div>
          </div>

          <div
            v-for="item in feedItems"
            :key="item.id"
            class="chat-message assistant-message"
            :data-tone="item.tone"
          >
            <div class="message-avatar assistant">QA</div>
            <div class="message-bubble assistant-bubble" :data-tone="item.tone">
              <p class="message-label">{{ item.label }}</p>
              <p class="message-body">{{ item.detail }}</p>
              <button
                v-if="item.screenshot"
                class="message-shot"
                type="button"
                @click="openScreenshot(item.screenshot, item.label)"
              >
                <img :src="item.screenshot" :alt="`${item.label} screenshot`" class="message-shot-image" />
                <span class="message-shot-caption">Open screenshot</span>
              </button>
            </div>
          </div>
        </div>

        <div class="composer composer-docked">
          <label class="composer-label" for="issue-url">Issue URL</label>
          <textarea
            id="issue-url"
            v-model="issueUrl"
            class="issue-input"
            placeholder="https://github.com/shopware/shopware/issues/15805"
            rows="3"
            :disabled="isRunning"
            @keydown="handleKeydown"
          />
          <div class="composer-footer">
            <div class="branch-field">
              <label class="composer-label branch-label" for="branch-name">Shopware branch</label>
              <input
                id="branch-name"
                v-model="branch"
                class="branch-input"
                list="shopware-branches"
                placeholder="trunk"
                :disabled="isRunning"
                @focus="loadBranches()"
                @input="loadBranches(branch)"
              />
              <datalist id="shopware-branches">
                <option v-for="branchOption in branchOptions" :key="branchOption.name" :value="branchOption.name">
                  {{ branchOption.name }}
                </option>
              </datalist>
            </div>

            <div class="composer-actions">
              <p class="hint">Enter sends the issue straight into the live Shopware test flow.</p>
              <button class="launch-button" type="button" :disabled="isRunning || !issueUrl.trim()" @click="submitIssue">
                {{ isRunning ? 'Streaming…' : 'Run Issue Check' }}
              </button>
            </div>
          </div>
        </div>
      </article>

      <aside class="sidebar">
        <article class="sidebar-card glass-card">
          <div class="panel-header compact">
            <div>
              <p class="panel-kicker">Tasks</p>
              <h2>Queue overview</h2>
            </div>
            <span class="counter small">{{ isLoadingTasks ? 'Refreshing…' : `${visibleTaskCount} visible` }}</span>
          </div>

          <p class="sidebar-copy">
            {{
              taskActionMessage ||
              'Switch between running and queued Shopware checks here, or stop them directly from the list.'
            }}
          </p>

          <div v-if="hasTasks" class="task-groups">
            <div class="task-group">
              <p class="task-group-title">Running</p>
              <div
                v-for="task in managedTasks.running"
                :key="task.jobId"
                class="task-item"
                :data-selected="selectedTaskId === task.jobId"
              >
                <button class="task-select" type="button" @click="selectTask(task.jobId)">
                  <div class="task-item-heading">
                    <span class="task-state-icon" :data-state="describeTaskState(task).className">
                      {{ describeTaskState(task).icon }}
                    </span>
                    <span class="task-state-label">{{ describeTaskState(task).label }}</span>
                  </div>
                  <p class="task-item-title">{{ task.issueTitle || `Task ${task.jobId}` }}</p>
                  <p class="task-item-meta">{{ task.branch || 'trunk' }} · {{ task.status }}</p>
                </button>
                <button
                  class="task-stop"
                  type="button"
                  :disabled="stoppingTaskId === task.jobId"
                  @click.stop="stopManagedTaskFromUi(task.jobId)"
                >
                  {{ task.cancellationRequested ? 'Stopping…' : stoppingTaskId === task.jobId ? 'Stopping…' : 'Stop' }}
                </button>
              </div>
            </div>

            <div class="task-group">
              <p class="task-group-title">Pending</p>
              <div
                v-for="task in managedTasks.pending"
                :key="task.jobId"
                class="task-item"
                :data-selected="selectedTaskId === task.jobId"
              >
                <button class="task-select" type="button" @click="selectTask(task.jobId)">
                  <div class="task-item-heading">
                    <span class="task-state-icon" :data-state="describeTaskState(task).className">
                      {{ describeTaskState(task).icon }}
                    </span>
                    <span class="task-state-label">{{ describeTaskState(task).label }}</span>
                  </div>
                  <p class="task-item-title">{{ task.issueTitle || `Task ${task.jobId}` }}</p>
                  <p class="task-item-meta">{{ task.branch || 'trunk' }} · {{ task.status }}</p>
                </button>
                <button
                  class="task-stop"
                  type="button"
                  :disabled="stoppingTaskId === task.jobId"
                  @click.stop="stopManagedTaskFromUi(task.jobId)"
                >
                  {{ stoppingTaskId === task.jobId ? 'Removing…' : 'Remove' }}
                </button>
              </div>
            </div>

            <div v-if="managedTasks.recent.length > 0" class="task-group">
              <div class="task-group-header">
                <p class="task-group-title">Recent results</p>
                <button
                  class="task-clear-all"
                  type="button"
                  :disabled="isClearingFinished"
                  @click="clearFinishedTasksFromUi"
                >
                  {{ isClearingFinished ? 'Clearing…' : 'Clear all' }}
                </button>
              </div>
              <div
                v-for="task in managedTasks.recent"
                :key="task.jobId"
                class="task-item"
                :data-selected="selectedTaskId === task.jobId"
              >
                <button class="task-select" type="button" @click="selectTask(task.jobId)">
                  <div class="task-item-heading">
                    <span class="task-state-icon" :data-state="describeTaskState(task).className">
                      {{ describeTaskState(task).icon }}
                    </span>
                    <span class="task-state-label">{{ describeTaskState(task).label }}</span>
                  </div>
                  <p class="task-item-title">{{ task.issueTitle || `Task ${task.jobId}` }}</p>
                  <p class="task-item-meta">{{ task.branch || 'trunk' }} · {{ task.status }}</p>
                </button>
                <button
                  class="task-stop"
                  type="button"
                  :disabled="stoppingTaskId === task.jobId"
                  @click.stop="stopManagedTaskFromUi(task.jobId)"
                >
                  {{ stoppingTaskId === task.jobId ? 'Removing…' : 'Remove' }}
                </button>
              </div>
            </div>
          </div>

          <p v-else class="sidebar-copy">No Shopware tasks are visible right now.</p>
        </article>

        <article class="sidebar-card glass-card">
          <div class="panel-header compact">
            <div>
              <p class="panel-kicker">Run Snapshot</p>
              <h2>Quiet telemetry</h2>
            </div>
          </div>

          <dl class="meta-list">
            <div>
              <dt>Status</dt>
              <dd>{{ statusLabel }}</dd>
            </div>
            <div>
              <dt>Job</dt>
              <dd>{{ currentJobId || 'Pending' }}</dd>
            </div>
            <div>
              <dt>Branch</dt>
              <dd>{{ currentBranch || submittedBranchLabel }}</dd>
            </div>
            <div>
              <dt>Admin URL</dt>
              <dd>{{ currentAdminUrl || 'Starting Shopware Administration…' }}</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd>{{ outcomeLabel }}</dd>
            </div>
          </dl>
        </article>

        <article class="sidebar-card glass-card">
          <div class="panel-header compact">
            <div>
              <p class="panel-kicker">Plan</p>
              <h2>Task framing</h2>
            </div>
          </div>

          <p class="sidebar-copy">{{ planSummary || 'The issue planner summary will appear here once the stream starts.' }}</p>
          <p class="sidebar-copy emphasis">{{ generatedTask || 'The agent task will appear here.' }}</p>

          <ol v-if="generatedSteps.length" class="compact-list">
            <li v-for="step in generatedSteps" :key="step">{{ step }}</li>
          </ol>
        </article>

        <article class="sidebar-card glass-card">
          <div class="panel-header compact">
            <div>
              <p class="panel-kicker">Result</p>
              <h2>Execution notes</h2>
            </div>
          </div>

          <p class="sidebar-copy">
            {{
              resultSummary ||
              errorMessage ||
              'Execution details stay secondary here while the chat feed remains the main story.'
            }}
          </p>

          <ol v-if="resultSteps.length" class="compact-list">
            <li v-for="step in resultSteps" :key="step">{{ step }}</li>
          </ol>

          <ul v-if="resultLogs.length" class="compact-log-list">
            <li v-for="log in resultLogs" :key="log">{{ log }}</li>
          </ul>
        </article>
      </aside>
    </section>

    <div v-if="expandedScreenshot" class="lightbox" role="dialog" aria-modal="true" @click.self="closeScreenshot">
      <div class="lightbox-card">
        <div class="lightbox-header">
          <p class="panel-kicker">Step Screenshot</p>
          <button class="lightbox-close" type="button" @click="closeScreenshot">Close</button>
        </div>
        <h2>{{ expandedScreenshot.label }}</h2>
        <img :src="expandedScreenshot.src" :alt="expandedScreenshot.label" class="lightbox-image" />
      </div>
    </div>
  </div>
</template>
