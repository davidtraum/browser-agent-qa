import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  DerivedIssueTestPlan,
  DerivedScenarioTestPlan,
  GitHubIssueSummary,
} from '../types/runTest';
import { config } from '../config';
import { generateStructuredOutput } from './promptAdapter';

const plannerSchema = {
  name: 'issue_test_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: {
        type: 'string',
      },
      task: {
        type: 'string',
      },
      steps: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
    },
    required: ['summary', 'task', 'steps'],
  },
} as const;

const additionalAiContext = (() => {
  try {
    return readFileSync(path.resolve(process.cwd(), '..', 'ai-context.md'), 'utf8').trim();
  } catch {
    try {
      return readFileSync(path.resolve(process.cwd(), 'ai-context.md'), 'utf8').trim();
    } catch {
      return '';
    }
  }
})();

const renderIssueContext = (issue: GitHubIssueSummary): string => {
  const comments = issue.comments.length
    ? issue.comments
        .map(
          (comment, index) =>
            `Comment ${index + 1} by ${comment.author} at ${comment.createdAt || 'unknown time'}:\n${comment.body || '(empty)'}`,
        )
        .join('\n\n')
    : 'No comments.';

  const labels = issue.labels.length ? issue.labels.join(', ') : 'None';

  return [
    `Repository: ${issue.repository}`,
    `${issue.kind === 'pull_request' ? 'Pull request' : 'Issue'}: #${issue.number} - ${issue.title}`,
    `State: ${issue.state}`,
    `Labels: ${labels}`,
    '',
    'Issue body:',
    issue.body || '(empty)',
    '',
    'Comments:',
    comments,
  ].join('\n');
};

export const deriveTestPlanFromIssue = async (issue: GitHubIssueSummary): Promise<DerivedIssueTestPlan> => {
  if (config.aiProvider === 'openai' && !config.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required to derive test steps from a GitHub issue.');
  }

  const parsed = await generateStructuredOutput<DerivedIssueTestPlan>({
    systemPrompt: [
      'You are a senior QA engineer focused on the Shopware Administration. Read the GitHub issue or pull request and derive the smallest realistic browser test plan that validates the described behavior or bug fix inside the Shopware admin. Focus on concrete UI actions and observable outcomes. When login is necessary, use the default administration credentials admin / shopware. Do not invent unavailable details.',
      additionalAiContext ? `\nAdditional context:\n${additionalAiContext}` : '',
    ].join(''),
    userPrompt: [
      `Create a browser test plan for the Shopware Administration from this GitHub ${
        issue.kind === 'pull_request' ? 'pull request' : 'issue'
      }.`,
      '',
      'Requirements:',
      '- Return a concise summary of what should be validated.',
      '- Return a single task string suitable for an autonomous browser QA agent.',
      '- Return 3 to 8 explicit test steps in logical order.',
      '- The task should assume the browser opens the Shopware Administration first.',
      '- Mention login with admin / shopware whenever the admin needs authentication.',
      '- Prefer assertions that can be verified visually and in the DOM.',
      '- If the source is a pull request, the plan should treat the run as PASS when the behavior described in the PR is correctly reproducible in the UI or when the named bug is fixed as described.',
      '',
      renderIssueContext(issue),
    ].join('\n'),
    schema: plannerSchema,
    openAiModel: config.issuePlannerModel,
  });

  if (!parsed.task || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('The planner model returned an invalid test plan.');
  }

  return {
    summary: parsed.summary.trim(),
    task: parsed.task.trim(),
    steps: parsed.steps.map((step) => step.trim()).filter(Boolean),
  };
};

export const deriveTestPlanFromScenario = async (
  scenario: string,
): Promise<DerivedScenarioTestPlan> => {
  if (config.aiProvider === 'openai' && !config.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required to derive test steps from a freeform scenario.');
  }

  const parsed = await generateStructuredOutput<DerivedScenarioTestPlan>({
    systemPrompt: [
      'You are a senior QA engineer focused on the Shopware Administration. Read the freeform scenario and turn it into the smallest realistic browser test plan that validates the requested behavior in the Shopware admin. Focus on concrete UI actions and observable outcomes. When login is necessary, use the default administration credentials admin / shopware. Do not invent unavailable details.',
      additionalAiContext ? `\nAdditional context:\n${additionalAiContext}` : '',
    ].join(''),
    userPrompt: [
      'Create a browser test plan for the Shopware Administration from this freeform scenario.',
      '',
      'Requirements:',
      '- Return a concise summary of what should be validated.',
      '- Return a single task string suitable for an autonomous browser QA agent.',
      '- Return 3 to 8 explicit test steps in logical order.',
      '- The task should assume the browser opens the Shopware Administration first.',
      '- Mention login with admin / shopware whenever the admin needs authentication.',
      '- Prefer assertions that can be verified visually and in the DOM.',
      '',
      'Scenario:',
      scenario,
    ].join('\n'),
    schema: plannerSchema,
    openAiModel: config.issuePlannerModel,
  });

  if (!parsed.task || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('The planner model returned an invalid scenario plan.');
  }

  return {
    summary: parsed.summary.trim(),
    task: parsed.task.trim(),
    steps: parsed.steps.map((step) => step.trim()).filter(Boolean),
  };
};
