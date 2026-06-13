/**
 * Agent instruction files (AGENTS.md / CLAUDE.md)
 *
 * Agent instruction files provide project-specific instructions loaded into the system prompt.
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// agentsFilesOverride can add, remove, or replace AGENTS.md / CLAUDE.md instructions before they are added to the system prompt.
const loader = new DefaultResourceLoader({
	cwd: process.cwd(),
	agentDir: getAgentDir(),
	agentsFilesOverride: (current) => ({
		agentsFiles: [
			...current.agentsFiles,
			{
				path: "/virtual/AGENTS.md",
				content: `# Project Guidelines

## Code Style
- Use TypeScript strict mode
- No any types
- Prefer const over let`,
			},
		],
	}),
});
await loader.reload();

// Discover AGENTS.md / CLAUDE.md files walking up from cwd
const discovered = loader.getAgentsFiles().agentsFiles;
console.log("Discovered agent instruction files:");
for (const file of discovered) {
	console.log(`  - ${file.path} (${file.content.length} chars)`);
}

const { session } = await createAgentSession({
	resourceLoader: loader,
	sessionManager: SessionManager.inMemory(),
});
console.log(`Session created with ${discovered.length} agent instruction files`);
session.dispose();
