# Pricing

session-analyzer and manage-claude-projects estimate cost from token counts with the same
table (USD per 1M tokens). Figures are estimates, not billing amounts.

| Models                | Input | Output | Cache write 5m | Cache write 1h | Cache read |
|-----------------------|-------|--------|----------------|----------------|------------|
| Fable 5.1, Mythos 5.1 | 10.00 | 50.00  | 12.50          | 20.00          | 0.25       |
| Fable 5, Mythos 5     | 10.00 | 50.00  | 12.50          | 20.00          | 1.00       |
| Opus 5.5              | 4.00  | 20.00  | 5.00           | 8.00           | 0.20       |
| Opus 5, Opus 4.5–4.8  | 5.00  | 25.00  | 6.25           | 10.00          | 0.50       |
| Opus 4, Opus 4.1      | 15.00 | 75.00  | 18.75          | 30.00          | 1.50       |
| Opus 3                | 15.00 | 75.00  | 18.75          | 30.00          | 1.50       |
| Sonnet 5.5            | 2.00  | 10.00  | 2.50           | 4.00           | 0.10       |
| Sonnet 5              | 2.00  | 10.00  | 2.50           | 4.00           | 0.20       |
| Sonnet 4, 4.5, 4.6    | 3.00  | 15.00  | 3.75           | 6.00           | 0.30       |
| Haiku 5.5¹            | 0.10  | 0.50   | 0.125          | 0.20           | 0.01       |
| Haiku 4.5             | 1.00  | 5.00   | 1.25           | 2.00           | 0.10       |
| Haiku 3.5             | 0.80  | 4.00   | 1.00           | 1.60           | 0.08       |
| Haiku 3               | 0.25  | 1.25   | 0.30           | 0.50           | 0.03       |

¹ For prompts up to 100K tokens. A longer request bills every token type at 5×.

A model id is matched to a row by substring (`opus-4-1`, `sonnet-5-5`, …), so Amazon Bedrock
and Google Vertex AI ids (`anthropic.claude-opus-4-20250514-v1:0`, `claude-opus-4@20250514`)
get the same row as Claude API ids. Ids that match no row (non-Claude models) are reported as
tokens only and left out of cost totals. Fast-mode requests are flagged but priced at the
standard rate.
