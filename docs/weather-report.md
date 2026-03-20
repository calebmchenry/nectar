<!-- Generated from https://factory.strongdm.ai/weather-report — do not edit, regenerate with: pnpm build -->

Weather Report

# Weather Report

What models we're running today, how they're configured, and what role each one plays in the factory.

[Subscribe via RSS](/weather-report/feed.xml)

**Why do we publish The Weather Report?** The Weather Report started out as a casual internal summary of how each provider and model was performing on our most important use cases. We update it frequently and have found it essential to our process.

As of March 12th, 2026

gpt-5.4 has been formally adopted for planning and architectural critique. It replaces gpt-5.2 in our Sprint Planning consensus pair and Architectural Critique. Gemini can improve consensus in some cases for sprint planning. We're continuing to evaluate gpt-5.4 for implementation tasks but keeping gpt-5.3-codex as our default implementation model for now.

| Use | Models (by preference) | Parameters | Notes |
| --- | --- | --- | --- |
| CS/Math Hard Problems
Feb 6

 | gpt-5.3-codex | default |  |
| Image comprehension

Feb 6

 | gemini-3-flash-preview | default |  |
| Frontend Aesthetics

Feb 6

 | opus-4.6 | default |  |
| Frontend Architecture

Feb 6

 | gpt-5.3-codex | default |  |
| Architectural Critique

Mar 12

 | gpt-5.4 | extra high |  |
| Sprint Planning

Mar 12

 | consensus(opus-4.6, gpt-5.4) | high / extra high | Gemini can improve consensus in some cases |
| Devops Tasks

Feb 6

 | opus-4.6 | default |  |
| QA Orchestration

Feb 6

 | opus-4.6 | default |  |
| Security review

Feb 6

 | gpt-5.3-codex | high |  |
| Bulk classification

Feb 6

 | Any | default | Go up cost and strength as needed |
| Bulk MapReduce

Feb 6

 | Any | default | Go up cost and strength as needed |
| UX Ideation

Feb 13

 | gemini-3-pro-image-preview | default | Nano Banana Pro |
| Agentic dialogues

Feb 13

 | gemini-3-flash-preview | default | General message handling loops with user interaction and limited tool calling |
| Voice (interactive)

Feb 23

 | gpt-realtime-1.5 | default | Internal use; not yet an official default |

*Consensus* operator refers to an LLM merge of the points from independent plans.

## Log

March 12th, 2026

gpt-5.4 has been formally adopted for planning and architectural critique. It replaces gpt-5.2 in our Sprint Planning consensus pair and Architectural Critique. Gemini can improve consensus in some cases for sprint planning. We're continuing to evaluate gpt-5.4 for implementation tasks but keeping gpt-5.3-codex as our default implementation model for now.

February 23rd, 2026

No specific changes in defaults, but please note for anyone evaluating Gemini 3.1, the gemini-3.1-pro-preview-customtools may significantly outperform gemini-3.1-pro-preview depending on your harness. We've switched to gpt-realtime-1.5 for our internal use cases but aren't officially defaulting to it yet. Very happy with Sonnet 4.6, it may overtake Opus for some of our everyday use cases.

February 13th, 2026

Happy with gpt-5.3-codex-spark. gpt-5.3-codex continues to be our preferred default implementation model with critiques and suggestions from Opus. Modified: Sprint Planning. Added: UX Ideation, Agentic dialogues, Voice (interactive).

February 6th, 2026

New models this week. We're very happy with gpt-5.3-codex. No problems with Opus 4.6 so far.
