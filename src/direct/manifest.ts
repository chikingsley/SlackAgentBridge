import fs from 'node:fs'

// Derive the limited direct-mode app from the single canonical manifest.
const manifest = JSON.parse(fs.readFileSync(new URL('../../slack/app-manifest.json', import.meta.url), 'utf8'))
manifest.display_information.name = 'Codex Agent Bridge'
manifest.display_information.description = 'Talk to one selected Codex agent in your workspace'
manifest.features.bot_user.display_name = 'Codex Agent'
delete manifest.features.app_home
manifest.features.slash_commands = manifest.features.slash_commands.filter((c: { command: string }) => ['/sab-status', '/sab-stop'].includes(c.command))
manifest.oauth_config.scopes.bot = ['commands', 'chat:write', 'channels:read', 'channels:history', 'groups:read', 'groups:history']
manifest.settings.event_subscriptions.bot_events = ['message.channels', 'message.groups']
console.log(JSON.stringify(manifest, null, 2))
