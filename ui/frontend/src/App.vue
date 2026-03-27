<script setup lang="ts">
import { computed, ref } from 'vue';
import { streamIssueRun } from './lib/stream';
import type { FeedEvent, TimelineItem } from './types';

const issueUrl = ref('');
const isRunning = ref(false);
const errorMessage = ref('');
const currentJobId = ref('');
const currentStatus = ref('idle');
const issueTitle = ref('');
const issueMeta = ref('');
const planSummary = ref('');
const generatedTask = ref('');
const generatedSteps = ref<string[]>([]);
const resultSummary = ref('');
const resultSteps = ref<string[]>([]);
const resultLogs = ref<string[]>([]);
const resultSuccess = ref<boolean | null>(null);
const feedItems = ref<TimelineItem[]>([]);

let activeController: AbortController | null = null;

const statusLabel = computed(() => {
  if (currentStatus.value === 'idle') {
    return 'Waiting';
  }

  return currentStatus.value;
});

const addFeedItem = (item: Omit<TimelineItem, 'id'>) => {
  feedItems.value.unshift({
    id: crypto.randomUUID(),
    ...item,
  });
};

const resetState = () => {
  errorMessage.value = '';
  currentJobId.value = '';
  currentStatus.value = 'starting';
  issueTitle.value = '';
  issueMeta.value = '';
  planSummary.value = '';
  generatedTask.value = '';
  generatedSteps.value = [];
  resultSummary.value = '';
  resultSteps.value = [];
  resultLogs.value = [];
  resultSuccess.value = null;
  feedItems.value = [];
};

const applyEvent = (event: FeedEvent) => {
  switch (event.type) {
    case 'accepted':
      addFeedItem({
        label: 'Request accepted',
        detail: `Preparing a live run for ${event.issueUrl} against ${event.targetAppUrl}.`,
        tone: 'info',
      });
      break;
    case 'issue':
      issueTitle.value = event.issue.title;
      issueMeta.value = `${event.issue.repository} · #${event.issue.number}`;
      addFeedItem({
        label: 'Issue analyzed',
        detail: event.issue.title,
        tone: 'info',
      });
      break;
    case 'plan':
      planSummary.value = event.summary;
      generatedTask.value = event.generatedTask;
      generatedSteps.value = event.generatedSteps;
      addFeedItem({
        label: 'Test plan ready',
        detail: event.summary,
        tone: 'info',
      });
      break;
    case 'job':
      currentJobId.value = event.jobId;
      addFeedItem({
        label: 'Worker queued',
        detail: `Job ${event.jobId} is now in the browser queue.`,
        tone: 'info',
      });
      break;
    case 'status':
      currentStatus.value = event.status;
      addFeedItem({
        label: 'Status update',
        detail: `${event.status} · attempt ${event.attemptsMade}`,
        tone: event.status === 'completed' ? 'success' : 'warning',
      });
      break;
    case 'result':
      resultSuccess.value = event.result.success;
      resultSummary.value = event.result.summary;
      resultSteps.value = event.result.steps;
      resultLogs.value = event.result.logs;
      currentStatus.value = event.result.success ? 'completed' : 'failed';
      addFeedItem({
        label: event.result.success ? 'Run completed' : 'Run failed',
        detail: event.result.summary,
        tone: event.result.success ? 'success' : 'danger',
      });
      break;
    case 'error':
      errorMessage.value = event.message;
      currentStatus.value = 'failed';
      addFeedItem({
        label: 'Error',
        detail: event.message,
        tone: 'danger',
      });
      break;
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
  resetState();

  try {
    await streamIssueRun(
      trimmed,
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
  }
};

const handleKeydown = async (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    await submitIssue();
  }
};
</script>

<template>
  <div class="shell">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Browser Agent Live Feed</p>
        <h1>Drop in a GitHub issue and watch the browser run unfold in real time.</h1>
        <p class="lede">
          The UI backend translates the issue into a browser test, sends it to the agent service, and streams the
          planning plus execution feed back into this panel.
        </p>
      </div>

      <div class="composer">
        <label class="composer-label" for="issue-url">Issue URL</label>
        <textarea
          id="issue-url"
          v-model="issueUrl"
          class="issue-input"
          placeholder="https://github.com/owner/repo/issues/123"
          rows="4"
          :disabled="isRunning"
          @keydown="handleKeydown"
        />
        <div class="composer-actions">
          <p class="hint">Press Enter to start the live issue check.</p>
          <button class="launch-button" type="button" :disabled="isRunning || !issueUrl.trim()" @click="submitIssue">
            {{ isRunning ? 'Running…' : 'Run Issue Check' }}
          </button>
        </div>
      </div>
    </section>

    <section class="dashboard">
      <article class="summary-panel glass-card">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">Run Snapshot</p>
            <h2>{{ issueTitle || 'No issue selected yet' }}</h2>
            <p v-if="issueMeta" class="muted">{{ issueMeta }}</p>
          </div>
          <span class="status-pill" :data-state="currentStatus">{{ statusLabel }}</span>
        </div>

        <dl class="summary-grid">
          <div>
            <dt>Job</dt>
            <dd>{{ currentJobId || 'Pending' }}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{{ planSummary || 'Waiting for the issue planner…' }}</dd>
          </div>
          <div>
            <dt>Task</dt>
            <dd>{{ generatedTask || 'The agent task will appear here.' }}</dd>
          </div>
          <div>
            <dt>Outcome</dt>
            <dd>
              {{
                resultSummary ||
                errorMessage ||
                'No execution result yet. The feed below will update live as the worker progresses.'
              }}
            </dd>
          </div>
        </dl>

        <div v-if="generatedSteps.length" class="detail-block">
          <h3>Planned steps</h3>
          <ol>
            <li v-for="step in generatedSteps" :key="step">{{ step }}</li>
          </ol>
        </div>

        <div v-if="resultSteps.length" class="detail-block">
          <h3>Execution steps</h3>
          <ol>
            <li v-for="step in resultSteps" :key="step">{{ step }}</li>
          </ol>
        </div>

        <div v-if="resultLogs.length" class="detail-block">
          <h3>Worker logs</h3>
          <ul class="log-list">
            <li v-for="log in resultLogs" :key="log">{{ log }}</li>
          </ul>
        </div>
      </article>

      <article class="feed-panel glass-card">
        <div class="panel-header">
          <div>
            <p class="panel-kicker">Live Feed</p>
            <h2>Timeline</h2>
          </div>
          <span class="counter">{{ feedItems.length }} events</span>
        </div>

        <div v-if="feedItems.length" class="timeline">
          <div v-for="item in feedItems" :key="item.id" class="timeline-item" :data-tone="item.tone">
            <div class="timeline-marker"></div>
            <div class="timeline-copy">
              <p class="timeline-label">{{ item.label }}</p>
              <p class="timeline-detail">{{ item.detail }}</p>
            </div>
          </div>
        </div>

        <div v-else class="empty-state">
          <p>No events yet.</p>
          <span>Paste an issue URL above and hit Enter to start streaming the planning and test execution feed.</span>
        </div>
      </article>
    </section>
  </div>
</template>

