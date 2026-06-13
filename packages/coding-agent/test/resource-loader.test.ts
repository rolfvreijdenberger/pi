import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

describe("DefaultResourceLoader", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("reload", () => {
		it("should initialize with empty results before reload", () => {
			const loader = new DefaultResourceLoader({ cwd, agentDir });

			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getSkills().skills).toEqual([]);
			expect(loader.getPrompts().prompts).toEqual([]);
			expect(loader.getThemes().themes).toEqual([]);
		});

		it("should discover skills from agentDir", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Skill content here.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "test-skill")).toBe(true);
		});

		it("should ignore extra markdown files in auto-discovered skill dirs", async () => {
			const skillDir = join(agentDir, "skills", "pi-skills", "browser-tools");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: browser-tools
description: Browser tools
---
Skill content here.`,
			);
			writeFileSync(join(skillDir, "EFFICIENCY.md"), "No frontmatter here");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { skills, diagnostics } = loader.getSkills();
			expect(skills.some((s) => s.name === "browser-tools")).toBe(true);
			expect(diagnostics.some((d) => d.path?.endsWith("EFFICIENCY.md"))).toBe(false);
		});

		it("should discover prompts from agentDir", async () => {
			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(
				join(promptsDir, "test-prompt.md"),
				`---
description: A test prompt
---
Prompt content.`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { prompts } = loader.getPrompts();
			expect(prompts.some((p) => p.name === "test-prompt")).toBe(true);
		});

		it("should prefer project resources over user on name collisions", async () => {
			const userPromptsDir = join(agentDir, "prompts");
			const projectPromptsDir = join(cwd, ".pi", "prompts");
			mkdirSync(userPromptsDir, { recursive: true });
			mkdirSync(projectPromptsDir, { recursive: true });
			const userPromptPath = join(userPromptsDir, "commit.md");
			const projectPromptPath = join(projectPromptsDir, "commit.md");
			writeFileSync(userPromptPath, "User prompt");
			writeFileSync(projectPromptPath, "Project prompt");

			const userSkillDir = join(agentDir, "skills", "collision-skill");
			const projectSkillDir = join(cwd, ".pi", "skills", "collision-skill");
			mkdirSync(userSkillDir, { recursive: true });
			mkdirSync(projectSkillDir, { recursive: true });
			const userSkillPath = join(userSkillDir, "SKILL.md");
			const projectSkillPath = join(projectSkillDir, "SKILL.md");
			writeFileSync(
				userSkillPath,
				`---
name: collision-skill
description: user
---
User skill`,
			);
			writeFileSync(
				projectSkillPath,
				`---
name: collision-skill
description: project
---
Project skill`,
			);

			const baseTheme = JSON.parse(
				readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
			) as { name: string; vars?: Record<string, string> };
			baseTheme.name = "collision-theme";
			const userThemePath = join(agentDir, "themes", "collision.json");
			const projectThemePath = join(cwd, ".pi", "themes", "collision.json");
			mkdirSync(join(agentDir, "themes"), { recursive: true });
			mkdirSync(join(cwd, ".pi", "themes"), { recursive: true });
			writeFileSync(userThemePath, JSON.stringify(baseTheme, null, 2));
			if (baseTheme.vars) {
				baseTheme.vars.accent = "#ff00ff";
			}
			writeFileSync(projectThemePath, JSON.stringify(baseTheme, null, 2));

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const prompt = loader.getPrompts().prompts.find((p) => p.name === "commit");
			expect(prompt?.filePath).toBe(projectPromptPath);

			const skill = loader.getSkills().skills.find((s) => s.name === "collision-skill");
			expect(skill?.filePath).toBe(projectSkillPath);

			const theme = loader.getThemes().themes.find((t) => t.name === "collision-theme");
			expect(theme?.sourcePath).toBe(projectThemePath);
		});

		it("should load symlinked user and project extensions once", async () => {
			const sharedExtDir = join(tempDir, "shared-extensions");
			mkdirSync(sharedExtDir, { recursive: true });
			writeFileSync(
				join(sharedExtDir, "shared.ts"),
				`export default function(pi) {
	pi.registerCommand("shared", {
		description: "shared command",
		handler: async () => {},
	});
}`,
			);

			mkdirSync(agentDir, { recursive: true });
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			symlinkSync(sharedExtDir, join(agentDir, "extensions"), "dir");
			symlinkSync(sharedExtDir, join(cwd, ".pi", "extensions"), "dir");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(1);
			expect(extensionsResult.errors).toEqual([]);

			// mergePaths processes project paths before user paths, so the project
			// alias is the canonical survivor.
			expect(extensionsResult.extensions[0].path).toBe(join(cwd, ".pi", "extensions", "shared.ts"));
		});

		it("should load user extensions before trust and reuse them after trust resolves", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, ".pi", "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });
			const loadCountKey = `__piTrustPreloadCount_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const globalState = globalThis as typeof globalThis & Record<string, number | undefined>;

			writeFileSync(
				join(userExtDir, "user.ts"),
				`globalThis[${JSON.stringify(loadCountKey)}] = (globalThis[${JSON.stringify(loadCountKey)}] ?? 0) + 1;
export default function(pi) {
	pi.on("project_trust", () => ({ trusted: "yes" }));
	pi.registerCommand("user-trust", {
		description: "user trust",
		handler: async () => {},
	});
}`,
			);
			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("project-trusted", {
		description: "project trusted",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload({
				resolveProjectTrust: async ({ extensionsResult }) => {
					expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
						join(userExtDir, "user.ts"),
					]);
					return true;
				},
			});

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions.map((extension) => extension.path)).toEqual([
				join(cwd, ".pi", "extensions", "project.ts"),
				join(userExtDir, "user.ts"),
			]);
			expect(globalState[loadCountKey]).toBe(1);
		});

		it("should keep both extensions loaded when command names collide", async () => {
			const userExtDir = join(agentDir, "extensions");
			const projectExtDir = join(cwd, ".pi", "extensions");
			mkdirSync(userExtDir, { recursive: true });
			mkdirSync(projectExtDir, { recursive: true });

			writeFileSync(
				join(projectExtDir, "project.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "project deploy",
		handler: async () => {},
	});
	pi.registerCommand("project-only", {
		description: "project only",
		handler: async () => {},
	});
}`,
			);

			writeFileSync(
				join(userExtDir, "user.ts"),
				`export default function(pi) {
	pi.registerCommand("deploy", {
		description: "user deploy",
		handler: async () => {},
	});
	pi.registerCommand("user-only", {
		description: "user only",
		handler: async () => {},
	});
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions).toHaveLength(2);
			expect(extensionsResult.errors.some((e) => e.error.includes('Command "/deploy" conflicts'))).toBe(false);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("project deploy");
			expect(runner.getCommand("deploy:2")?.description).toBe("user deploy");
			expect(runner.getCommand("project-only")?.description).toBe("project only");
			expect(runner.getCommand("user-only")?.description).toBe("user only");

			const commands = runner.getRegisteredCommands();
			expect(commands.map((command) => command.invocationName)).toEqual([
				"deploy:1",
				"project-only",
				"deploy:2",
				"user-only",
			]);
		});

		it("should honor overrides for auto-discovered resources", async () => {
			const settingsManager = SettingsManager.inMemory();
			settingsManager.setExtensionPaths(["-extensions/disabled.ts"]);
			settingsManager.setSkillPaths(["-skills/skip-skill"]);
			settingsManager.setPromptTemplatePaths(["-prompts/skip.md"]);
			settingsManager.setThemePaths(["-themes/skip.json"]);

			const extensionsDir = join(agentDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "disabled.ts"), "export default function() {}");

			const skillDir = join(agentDir, "skills", "skip-skill");
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: skip-skill
description: Skip me
---
Content`,
			);

			const promptsDir = join(agentDir, "prompts");
			mkdirSync(promptsDir, { recursive: true });
			writeFileSync(join(promptsDir, "skip.md"), "Skip prompt");

			const themesDir = join(agentDir, "themes");
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(themesDir, "skip.json"), "{}");

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			const { extensions } = loader.getExtensions();
			const { skills } = loader.getSkills();
			const { prompts } = loader.getPrompts();
			const { themes } = loader.getThemes();

			expect(extensions.some((e) => e.path.endsWith("disabled.ts"))).toBe(false);
			expect(skills.some((s) => s.name === "skip-skill")).toBe(false);
			expect(prompts.some((p) => p.name === "skip")).toBe(false);
			expect(themes.some((t) => t.sourcePath?.endsWith("skip.json"))).toBe(false);
		});

		it("should discover AGENTS.md context files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles.some((f) => f.path.includes("AGENTS.md"))).toBe(true);
		});

		it("should normalize agent instruction files returned from agentsFilesOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				agentsFilesOverride: () => ({
					agentsFiles: [{ path: join(cwd, "virtual", "CLAUDE.md"), content: "Claude instructions" }],
				}),
			});
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles).toEqual([
				{
					path: join(cwd, "virtual", "CLAUDE.md"),
					content: "Claude instructions",
					contextKind: "claude",
					fileName: "CLAUDE.md",
				},
			]);
		});

		it("should keep overridden agent instruction statuses when agentsFilesOverride filters active files", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "Project agent instructions");
			writeFileSync(join(cwd, "CLAUDE.md"), "Project Claude instructions");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				agentsFilesOverride: (current) => ({
					agentsFiles: current.agentsFiles.filter((file) => file.fileName !== "AGENTS.md"),
				}),
			});
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
			expect(
				loader
					.getStartupContextSourceStatuses()
					.filter((file) => file.kind === "context" && file.path.startsWith(cwd)),
			).toEqual([
				{
					kind: "context",
					status: "overridden",
					origin: "project",
					path: join(cwd, "CLAUDE.md"),
					contextKind: "claude",
					fileName: "CLAUDE.md",
				},
				{
					kind: "context",
					status: "overridden",
					origin: "project",
					path: join(cwd, "AGENTS.md"),
					contextKind: "agents",
					fileName: "AGENTS.md",
				},
			]);
		});

		it("should report CLAUDE.md and CLAUDE.MD context files when they are loaded", async () => {
			const parentDir = join(cwd, "nested");
			const childDir = join(parentDir, "child");
			mkdirSync(childDir, { recursive: true });
			writeFileSync(join(agentDir, "CLAUDE.md"), "Global Claude instructions");
			writeFileSync(join(parentDir, "CLAUDE.MD"), "Parent Claude instructions");

			const loader = new DefaultResourceLoader({ cwd: childDir, agentDir });
			await loader.reload();

			const contextFilePaths = loader.getAgentsFiles().agentsFiles.map((file) => file.path.replace(/\\/g, "/"));
			expect(contextFilePaths[0]).toBe(join(agentDir, "CLAUDE.md").replace(/\\/g, "/"));
			expect(contextFilePaths.some((filePath) => filePath.toLowerCase().endsWith("/nested/claude.md"))).toBe(true);

			const contextStatuses = loader.getStartupContextSourceStatuses().filter((file) => file.kind === "context");
			expect(contextStatuses[0]).toEqual({
				kind: "context",
				status: "active",
				origin: "user",
				path: join(agentDir, "CLAUDE.md"),
				contextKind: "claude",
				fileName: "CLAUDE.md",
			});
			expect(
				contextStatuses.some(
					(file) =>
						"path" in file &&
						file.origin === "project" &&
						file.path.replace(/\\/g, "/").toLowerCase().endsWith("/nested/claude.md"),
				),
			).toBe(true);
		});

		it("should prefer AGENTS.md over CLAUDE.md in the same directory and report CLAUDE.md overridden", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "Project agent instructions");
			writeFileSync(join(cwd, "CLAUDE.md"), "Project Claude instructions");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md"))).toBe(true);
			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "CLAUDE.md"))).toBe(false);
			expect(
				loader
					.getStartupContextSourceStatuses()
					.filter((file) => file.kind === "context" && file.path.startsWith(cwd)),
			).toEqual([
				{
					kind: "context",
					status: "overridden",
					origin: "project",
					path: join(cwd, "CLAUDE.md"),
					contextKind: "claude",
					fileName: "CLAUDE.md",
				},
				{
					kind: "context",
					status: "active",
					origin: "project",
					path: join(cwd, "AGENTS.md"),
					contextKind: "agents",
					fileName: "AGENTS.md",
				},
			]);
		});

		it("should skip AGENTS.md and CLAUDE.md discovery when noContextFiles is true", async () => {
			writeFileSync(join(cwd, "AGENTS.md"), "# Project Guidelines\n\nBe helpful.");
			writeFileSync(join(cwd, "CLAUDE.md"), "# Claude Guidelines\n\nBe helpful.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, noContextFiles: true });
			await loader.reload();

			const { agentsFiles } = loader.getAgentsFiles();
			expect(agentsFiles).toEqual([]);
		});

		it("should discover SYSTEM.md from cwd/.pi", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "You are a helpful assistant.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("You are a helpful assistant.");
		});

		it("should ignore prompt directories when discovering system prompt files", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(join(piDir, "SYSTEM.md"), { recursive: true });
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Global system prompt.");
			expect(loader.getStartupContextSourceStatuses().filter((file) => file.kind === "system")).toEqual([
				{ kind: "system", status: "active", origin: "user", path: join(agentDir, "SYSTEM.md") },
			]);
		});

		it("should skip project resources that require trust when project is not trusted", async () => {
			const piDir = join(cwd, ".pi");
			const extensionsDir = join(piDir, "extensions");
			const skillDir = join(piDir, "skills", "project-skill");
			const promptsDir = join(piDir, "prompts");
			const themesDir = join(piDir, "themes");
			mkdirSync(extensionsDir, { recursive: true });
			mkdirSync(skillDir, { recursive: true });
			mkdirSync(promptsDir, { recursive: true });
			mkdirSync(themesDir, { recursive: true });
			writeFileSync(join(piDir, "SYSTEM.md"), "Project system prompt.");
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
			writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");
			writeFileSync(join(extensionsDir, "project.ts"), `throw new Error("should not load");`);
			writeFileSync(
				join(skillDir, "SKILL.md"),
				`---
name: project-skill
description: Project skill
---
Project skill content`,
			);
			writeFileSync(join(promptsDir, "project.md"), "Project prompt");
			const themeData = JSON.parse(
				readFileSync(join(process.cwd(), "src", "modes", "interactive", "theme", "dark.json"), "utf-8"),
			) as { name: string };
			themeData.name = "project-theme";
			writeFileSync(join(themesDir, "project.json"), JSON.stringify(themeData, null, 2));
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });

			const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Global system prompt.");
			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(agentDir, "AGENTS.md"))).toBe(
				true,
			);
			expect(loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(cwd, "AGENTS.md"))).toBe(true);
			expect(loader.getExtensions().extensions).toHaveLength(0);
			expect(loader.getExtensions().errors).toEqual([]);
			expect(loader.getSkills().skills.some((skill) => skill.name === "project-skill")).toBe(false);
			expect(loader.getPrompts().prompts.some((prompt) => prompt.name === "project")).toBe(false);
			expect(loader.getThemes().themes.some((theme) => theme.name === "project-theme")).toBe(false);
		});

		it("should discover APPEND_SYSTEM.md", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Additional instructions.");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toContain("Additional instructions.");
		});

		it("should report context file status in system, append, then hierarchical context order", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(piDir, "SYSTEM.md"), "Project system prompt.");
			writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Global append prompt.");
			writeFileSync(join(piDir, "APPEND_SYSTEM.md"), "Project append prompt.");
			writeFileSync(join(agentDir, "AGENTS.md"), "Global instructions");
			writeFileSync(join(cwd, "AGENTS.md"), "Project instructions");

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const startupContextStatuses = loader.getStartupContextSourceStatuses();
			expect(startupContextStatuses.filter((file) => file.kind !== "context")).toEqual([
				{ kind: "system", status: "overridden", origin: "user", path: join(agentDir, "SYSTEM.md") },
				{ kind: "system", status: "active", origin: "project", path: join(piDir, "SYSTEM.md") },
				{
					kind: "append-system",
					status: "overridden",
					origin: "user",
					path: join(agentDir, "APPEND_SYSTEM.md"),
				},
				{
					kind: "append-system",
					status: "active",
					origin: "project",
					path: join(piDir, "APPEND_SYSTEM.md"),
				},
			]);

			const contextStatuses = startupContextStatuses.filter((file) => file.kind === "context");
			expect(contextStatuses[0]).toEqual({
				kind: "context",
				status: "active",
				origin: "user",
				path: join(agentDir, "AGENTS.md"),
				contextKind: "agents",
				fileName: "AGENTS.md",
			});
			expect(contextStatuses[contextStatuses.length - 1]).toEqual({
				kind: "context",
				status: "active",
				origin: "project",
				path: join(cwd, "AGENTS.md"),
				contextKind: "agents",
				fileName: "AGENTS.md",
			});
		});

		it("should report CLI system prompt text without exposing its contents as context", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(piDir, "SYSTEM.md"), "Project system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: "literal secret prompt" });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("literal secret prompt");
			expect(loader.getStartupContextSourceStatuses().filter((file) => file.kind !== "context")).toEqual([
				{ kind: "system", status: "overridden", origin: "user", path: join(agentDir, "SYSTEM.md") },
				{ kind: "system", status: "overridden", origin: "project", path: join(piDir, "SYSTEM.md") },
				{ kind: "system", status: "active", origin: "cli", label: "--system-prompt" },
			]);
		});

		it("should report CLI system prompt files while marking discovered files overridden", async () => {
			const piDir = join(cwd, ".pi");
			const cliSystemPrompt = join(tempDir, "cli-system.md");
			mkdirSync(piDir, { recursive: true });
			writeFileSync(cliSystemPrompt, "CLI system prompt.");
			writeFileSync(join(agentDir, "SYSTEM.md"), "Global system prompt.");
			writeFileSync(join(piDir, "SYSTEM.md"), "Project system prompt.");

			const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: cliSystemPrompt });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("CLI system prompt.");
			expect(loader.getStartupContextSourceStatuses().filter((file) => file.kind !== "context")).toEqual([
				{ kind: "system", status: "overridden", origin: "user", path: join(agentDir, "SYSTEM.md") },
				{ kind: "system", status: "overridden", origin: "project", path: join(piDir, "SYSTEM.md") },
				{
					kind: "system",
					status: "active",
					origin: "cli",
					path: cliSystemPrompt,
					label: "--system-prompt",
				},
			]);
		});

		it("should report existing CLI system prompt directories as literal labels, not files", async () => {
			const cliSystemPromptDirectory = join(tempDir, "cli-system-dir");
			mkdirSync(cliSystemPromptDirectory, { recursive: true });

			const loader = new DefaultResourceLoader({ cwd, agentDir, systemPrompt: cliSystemPromptDirectory });
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe(cliSystemPromptDirectory);
			expect(loader.getStartupContextSourceStatuses().filter((file) => file.kind === "system")).toEqual([
				{ kind: "system", status: "active", origin: "cli", label: "--system-prompt" },
			]);
		});

		it("should report CLI append system prompt sources in argument order", async () => {
			const cliAppendPrompt = join(tempDir, "cli-append.md");
			writeFileSync(cliAppendPrompt, "CLI append prompt.");
			writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Global append prompt.");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				appendSystemPrompt: ["literal append secret", cliAppendPrompt],
			});
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual(["literal append secret", "CLI append prompt."]);
			expect(loader.getStartupContextSourceStatuses().filter((file) => file.kind !== "context")).toEqual([
				{
					kind: "append-system",
					status: "overridden",
					origin: "user",
					path: join(agentDir, "APPEND_SYSTEM.md"),
				},
				{
					kind: "append-system",
					status: "active",
					origin: "cli",
					label: "--append-system-prompt #1",
					index: 1,
				},
				{
					kind: "append-system",
					status: "active",
					origin: "cli",
					path: cliAppendPrompt,
					label: "--append-system-prompt #2",
					index: 2,
				},
			]);
		});

		it("should dedupe CLI append files against discovered append files", async () => {
			const piDir = join(cwd, ".pi");
			mkdirSync(piDir, { recursive: true });
			const projectAppendPrompt = join(piDir, "APPEND_SYSTEM.md");
			writeFileSync(projectAppendPrompt, "Project append prompt.");
			writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "Global append prompt.");

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				appendSystemPrompt: [join(".pi", "APPEND_SYSTEM.md"), projectAppendPrompt],
			});
			await loader.reload();

			expect(loader.getAppendSystemPrompt()).toEqual(["Project append prompt."]);
			expect(loader.getStartupContextSourceStatuses().filter((file) => file.kind !== "context")).toEqual([
				{
					kind: "append-system",
					status: "overridden",
					origin: "user",
					path: join(agentDir, "APPEND_SYSTEM.md"),
				},
				{
					kind: "append-system",
					status: "active",
					origin: "cli",
					path: projectAppendPrompt,
					label: "--append-system-prompt #1",
					index: 1,
				},
			]);
		});
	});

	describe("extendResources", () => {
		it("should load skills and prompts with extension metadata", async () => {
			const extraSkillDir = join(tempDir, "extra-skills", "extra-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: extra-skill
description: Extra skill
---
Extra content`,
			);

			const extraPromptDir = join(tempDir, "extra-prompts");
			mkdirSync(extraPromptDir, { recursive: true });
			const promptPath = join(extraPromptDir, "extra.md");
			writeFileSync(
				promptPath,
				`---
description: Extra prompt
---
Extra prompt content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: extraSkillDir,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
				promptPaths: [
					{
						path: promptPath,
						metadata: {
							source: "extension:extra",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraPromptDir,
						},
					},
				],
			});

			const { skills } = loader.getSkills();
			const loadedSkill = skills.find((skill) => skill.name === "extra-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedSkill?.sourceInfo?.path).toBe(skillPath);

			const { prompts } = loader.getPrompts();
			const loadedPrompt = prompts.find((prompt) => prompt.name === "extra");
			expect(loadedPrompt).toBeDefined();
			expect(loadedPrompt?.sourceInfo?.source).toBe("extension:extra");
			expect(loadedPrompt?.sourceInfo?.path).toBe(promptPath);
		});

		it("should load extension resources returned as file URLs", async () => {
			const extraSkillDir = join(tempDir, "extra skills", "file-url-skill");
			mkdirSync(extraSkillDir, { recursive: true });
			const skillPath = join(extraSkillDir, "SKILL.md");
			writeFileSync(
				skillPath,
				`---
name: file-url-skill
description: File URL skill
---
Extra content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			loader.extendResources({
				skillPaths: [
					{
						path: pathToFileURL(extraSkillDir).href,
						metadata: {
							source: "extension:file-url",
							scope: "temporary",
							origin: "top-level",
							baseDir: extraSkillDir,
						},
					},
				],
			});

			const { skills, diagnostics } = loader.getSkills();
			expect(diagnostics).toEqual([]);
			const loadedSkill = skills.find((skill) => skill.name === "file-url-skill");
			expect(loadedSkill).toBeDefined();
			expect(loadedSkill?.filePath).toBe(skillPath);
			expect(loadedSkill?.sourceInfo?.source).toBe("extension:file-url");
		});
	});

	describe("noSkills option", () => {
		it("should skip skill discovery when noSkills is true", async () => {
			const skillsDir = join(agentDir, "skills");
			mkdirSync(skillsDir, { recursive: true });
			writeFileSync(
				join(skillsDir, "test-skill.md"),
				`---
name: test-skill
description: A test skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true });
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toEqual([]);
		});

		it("should still load additional skill paths when noSkills is true", async () => {
			const customSkillDir = join(tempDir, "custom-skills");
			mkdirSync(customSkillDir, { recursive: true });
			writeFileSync(
				join(customSkillDir, "custom.md"),
				`---
name: custom
description: Custom skill
---
Content`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				noSkills: true,
				additionalSkillPaths: [customSkillDir],
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills.some((s) => s.name === "custom")).toBe(true);
		});
	});

	describe("override functions", () => {
		it("should apply skillsOverride", async () => {
			const injectedSkill: Skill = {
				name: "injected",
				description: "Injected skill",
				filePath: "/fake/path",
				baseDir: "/fake",
				sourceInfo: createSyntheticSourceInfo("/fake/path", { source: "custom" }),
				disableModelInvocation: false,
			};
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				skillsOverride: () => ({
					skills: [injectedSkill],
					diagnostics: [],
				}),
			});
			await loader.reload();

			const { skills } = loader.getSkills();
			expect(skills).toHaveLength(1);
			expect(skills[0].name).toBe("injected");
		});

		it("should apply systemPromptOverride", async () => {
			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				systemPromptOverride: () => "Custom system prompt",
			});
			await loader.reload();

			expect(loader.getSystemPrompt()).toBe("Custom system prompt");
		});
	});

	describe("extension conflict detection", () => {
		it("should detect tool conflicts between extensions", async () => {
			// Create two extensions that register the same tool
			const ext1Dir = join(agentDir, "extensions", "ext1");
			const ext2Dir = join(agentDir, "extensions", "ext2");
			mkdirSync(ext1Dir, { recursive: true });
			mkdirSync(ext2Dir, { recursive: true });

			writeFileSync(
				join(ext1Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "First",
    parameters: Type.Object({}),
    execute: async () => ({ result: "1" }),
  });
}`,
			);

			writeFileSync(
				join(ext2Dir, "index.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "Second",
    parameters: Type.Object({}),
    execute: async () => ({ result: "2" }),
  });
}`,
			);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const { errors } = loader.getExtensions();
			expect(errors.some((e) => e.error.includes("duplicate-tool") && e.error.includes("conflicts"))).toBe(true);
		});

		it("should prefer explicit CLI extensions over discovered extensions when commands and tools conflict", async () => {
			const globalExtDir = join(agentDir, "extensions");
			mkdirSync(globalExtDir, { recursive: true });
			const explicitExtPath = join(tempDir, "explicit-extension.ts");

			writeFileSync(
				join(globalExtDir, "global.ts"),
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "global tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "global" }),
  });
  pi.registerCommand("deploy", {
    description: "global command",
    handler: async () => {},
  });
}`,
			);

			writeFileSync(
				explicitExtPath,
				`
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function(pi: ExtensionAPI) {
  pi.registerTool({
    name: "duplicate-tool",
    description: "explicit tool",
    parameters: Type.Object({}),
    execute: async () => ({ result: "explicit" }),
  });
  pi.registerCommand("deploy", {
    description: "explicit command",
    handler: async () => {},
  });
}`,
			);

			const loader = new DefaultResourceLoader({
				cwd,
				agentDir,
				additionalExtensionPaths: [explicitExtPath],
			});
			await loader.reload();

			const extensionsResult = loader.getExtensions();
			expect(extensionsResult.extensions[0]?.path).toBe(explicitExtPath);

			const sessionManager = SessionManager.inMemory();
			const authStorage = AuthStorage.create(join(tempDir, "auth-explicit.json"));
			const modelRegistry = ModelRegistry.create(authStorage);
			const runner = new ExtensionRunner(
				extensionsResult.extensions,
				extensionsResult.runtime,
				cwd,
				sessionManager,
				modelRegistry,
			);

			expect(runner.getCommand("deploy:1")?.description).toBe("explicit command");
			expect(runner.getCommand("deploy:2")?.description).toBe("global command");
			expect(runner.getToolDefinition("duplicate-tool")?.description).toBe("explicit tool");
		});
	});
});
