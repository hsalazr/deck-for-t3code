/**
 * Quick messages as a user might set them up for the marketing renders: the
 * plugin's defaults (DEFAULT_MESSAGES) followed by a few of their own.
 * `Label | full text` is allowed, as in the real settings.
 */
import { DEFAULT_MESSAGES, parseQuickMessages } from "../src/model.ts";

export const EXAMPLE_MESSAGES = parseQuickMessages(
	[
		...DEFAULT_MESSAGES,
		"Tests | add tests for this",
		"check for flaky tests",
		"update the changelog",
		"list open TODOs",
		"try a simpler approach",
		"show me the diff",
		"double-check edge cases",
	].join("\n"),
);
