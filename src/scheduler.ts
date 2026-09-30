/** Scheduling plans only; rendering never writes files or installs a job. */
export function shellArgument(value: string): string { if (/[\0\r\n]/.test(value)) throw new Error("Scheduled arguments cannot contain NUL/newlines"); return `'${value.replace(/'/g, `'"'"'`)}'`; }
function xml(value: string): string { return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!)); }
export function renderSchedulerPlan(options: { project: string; bun: string; platform: "darwin" | "linux"; timezone?: string }): { content: string; timezone: string; instruction: string } {
  shellArgument(options.project); shellArgument(options.bun);
  const timezone = options.timezone ?? "America/Los_Angeles";
  if (timezone !== "America/Los_Angeles") throw new Error("This plan requires America/Los_Angeles calendar policy");
  if (options.platform === "darwin") return { timezone, instruction: "Review the plist and confirm the host calendar timezone is America/Los_Angeles before installation.", content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.crescentcity.weekly-check</string><key>ProgramArguments</key><array><string>${xml(options.bun)}</string><string>run</string><string>weekly-check</string></array><key>WorkingDirectory</key><string>${xml(options.project)}</string><key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict><key>StandardOutPath</key><string>${xml(options.project)}/output/logs/weekly-check.stdout.log</string><key>StandardErrorPath</key><string>${xml(options.project)}/output/logs/weekly-check.stderr.log</string></dict></plist>\n` };
  const command = `cd ${shellArgument(options.project)} && ${shellArgument(options.bun)} run weekly-check >> ${shellArgument(`${options.project}/output/logs/weekly-check.log`)} 2>&1`;
  return { timezone, instruction: "Review CRON_TZ support and create the log directory before installing this plan.", content: `CRON_TZ=${timezone}\n0 7 * * 0 ${command.replace(/%/g, "\\%")} # crescent-city\n` };
}
