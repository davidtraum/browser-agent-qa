import OpenAI from 'openai';
import { config } from '../config';
import type { DerivedIssueTestPlan, GitHubIssueSummary } from '../types/runTest';

const plannerClient = config.openAiApiKey
  ? new OpenAI({
      apiKey: config.openAiApiKey,
    })
  : null;

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
    `Issue: #${issue.number} - ${issue.title}`,
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
  if (!plannerClient) {
    throw new Error('OPENAI_API_KEY is required to derive test steps from a GitHub issue.');
  }

  const response = await plannerClient.chat.completions.create({
    model: config.issuePlannerModel,
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: plannerSchema,
    },
    messages: [
      {
        role: 'system',
        content:
          'You are a senior QA engineer. Read the GitHub issue and derive the smallest realistic browser test plan that validates the described behavior or bug fix. Focus on concrete UI actions and observable outcomes. Do not invent unavailable details.',
      },
      {
        role: 'user',
        content: [
          'Create a browser test plan from this GitHub issue.',
          '',
          'Requirements:',
          '- Return a concise summary of what should be validated.',
          '- Return a single task string suitable for an autonomous browser QA agent.',
          '- Return 3 to 8 explicit test steps in logical order.',
          '- Mention login only if the issue suggests authenticated behavior.',
          '- Prefer assertions that can be verified visually and in the DOM.',
          '',
          renderIssueContext(issue),
        ].join('\n'),
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('The planner model did not return any content.');
  }

  const parsed = JSON.parse(content) as DerivedIssueTestPlan;

  if (!parsed.task || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error('The planner model returned an invalid test plan.');
  }

  return {
    summary: parsed.summary.trim(),
    task: parsed.task.trim(),
    steps: parsed.steps.map((step) => step.trim()).filter(Boolean),
  };
};
