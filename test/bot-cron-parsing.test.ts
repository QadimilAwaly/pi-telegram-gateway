import { describe, test, expect } from "bun:test";
import { isValidCronExpression } from "../src/cron-scheduler";

function stripOuterQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseAddScheduleAndPrompt(input: string): { id?: string; cronExpression: string; prompt: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // 1. Quoted cron (with optional ID): [id] "cron" [prompt] or [id] 'cron' [prompt]
  const doubleQuoted = trimmed.match(/^(?:([a-zA-Z0-9_-]+)\s+)?"([^"]+)"(?:\s+(.*))?$/s);
  if (doubleQuoted && isValidCronExpression(doubleQuoted[2]!)) {
    return {
      id: doubleQuoted[1],
      cronExpression: doubleQuoted[2]!.trim(),
      prompt: stripOuterQuotes(doubleQuoted[3] || ""),
    };
  }
  const singleQuoted = trimmed.match(/^(?:([a-zA-Z0-9_-]+)\s+)?'([^']+)'(?:\s+(.*))?$/s);
  if (singleQuoted && isValidCronExpression(singleQuoted[2]!)) {
    return {
      id: singleQuoted[1],
      cronExpression: singleQuoted[2]!.trim(),
      prompt: stripOuterQuotes(singleQuoted[3] || ""),
    };
  }

  // 2. Nicknames: [id] @daily [prompt]
  const nickMatch = trimmed.match(/^(?:([a-zA-Z0-9_-]+)\s+)?(@[a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
  if (nickMatch && isValidCronExpression(nickMatch[2]!)) {
    return {
      id: nickMatch[1],
      cronExpression: nickMatch[2]!.trim(),
      prompt: stripOuterQuotes(nickMatch[3] || ""),
    };
  }

  // 3. Unquoted parts: 5 or 6 token cron
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 5) {
    const expr5 = parts.slice(0, 5).join(" ");
    if (isValidCronExpression(expr5)) {
      return {
        id: undefined,
        cronExpression: expr5,
        prompt: stripOuterQuotes(parts.slice(5).join(" ")),
      };
    }
  }
  if (parts.length >= 6) {
    const expr6 = parts.slice(0, 6).join(" ");
    if (isValidCronExpression(expr6)) {
      return {
        id: undefined,
        cronExpression: expr6,
        prompt: stripOuterQuotes(parts.slice(6).join(" ")),
      };
    }
    const withId5 = parts.slice(1, 6).join(" ");
    if (isValidCronExpression(withId5)) {
      return {
        id: parts[0],
        cronExpression: withId5,
        prompt: stripOuterQuotes(parts.slice(6).join(" ")),
      };
    }
  }
  if (parts.length >= 7) {
    const withId6 = parts.slice(1, 7).join(" ");
    if (isValidCronExpression(withId6)) {
      return {
        id: parts[0],
        cronExpression: withId6,
        prompt: stripOuterQuotes(parts.slice(7).join(" ")),
      };
    }
  }

  return null;
}

function parseEditFlags(editArgs: string) {
  let newCron: string | undefined;
  let newPrompt: string | undefined;
  let newName: string | undefined;
  let newTz: string | undefined;
  let newNoAgent: boolean | undefined;

  const hasFlags = /--[a-zA-Z0-9_-]+/.test(editArgs);
  if (hasFlags) {
    const flagRegex = /--([a-zA-Z0-9_-]+)(?:\s+(?:"([^"]*)"|'([^']*)'|((?:(?! --).)+?))(?=\s+--|$))?/gs;
    let match: RegExpExecArray | null;
    while ((match = flagRegex.exec(editArgs)) !== null) {
      const key = match[1]!.toLowerCase();
      const val = (match[2] ?? match[3] ?? match[4] ?? "true").trim();
      if (key === "cron") newCron = val;
      else if (key === "prompt") newPrompt = val;
      else if (key === "name") newName = val;
      else if (key === "tz" || key === "timezone") newTz = val;
      else if (key === "mode") {
        if (val.toLowerCase() === "script") newNoAgent = true;
        if (val.toLowerCase() === "agent") newNoAgent = false;
      } else if (key === "script") newNoAgent = true;
      else if (key === "agent") newNoAgent = false;
    }
  } else {
    const parsedPositional = parseAddScheduleAndPrompt(editArgs);
    if (parsedPositional) {
      newCron = parsedPositional.cronExpression;
      if (parsedPositional.prompt) {
        newPrompt = parsedPositional.prompt;
      }
    } else {
      newPrompt = stripOuterQuotes(editArgs);
    }
  }

  return { newCron, newPrompt, newName, newTz, newNoAgent };
}

describe("Telegram /cron Argument Parser", () => {
  test("parses quoted cron pattern and preserves prompt internal quotes", () => {
    const res = parseAddScheduleAndPrompt('"0 8 * * *" echo "hello world"');
    expect(res).not.toBeNull();
    expect(res?.cronExpression).toBe("0 8 * * *");
    expect(res?.prompt).toBe('echo "hello world"');
    expect(res?.id).toBeUndefined();
  });

  test("parses custom ID with quoted cron and prompt", () => {
    const res = parseAddScheduleAndPrompt('daily_task "0 8 * * *" python3 -c \'print("ok")\'');
    expect(res).not.toBeNull();
    expect(res?.id).toBe("daily_task");
    expect(res?.cronExpression).toBe("0 8 * * *");
    expect(res?.prompt).toBe('python3 -c \'print("ok")\'');
  });

  test("parses unquoted 5-token cron", () => {
    const res = parseAddScheduleAndPrompt("0 8 * * * Check morning news");
    expect(res).not.toBeNull();
    expect(res?.cronExpression).toBe("0 8 * * *");
    expect(res?.prompt).toBe("Check morning news");
    expect(res?.id).toBeUndefined();
  });

  test("parses custom ID with unquoted 5-token cron", () => {
    const res = parseAddScheduleAndPrompt("morning_task 0 8 * * * Run daily check");
    expect(res).not.toBeNull();
    expect(res?.id).toBe("morning_task");
    expect(res?.cronExpression).toBe("0 8 * * *");
    expect(res?.prompt).toBe("Run daily check");
  });

  test("parses nicknames (@daily, @hourly)", () => {
    const res1 = parseAddScheduleAndPrompt('@daily echo "clean temp"');
    expect(res1?.cronExpression).toBe("@daily");
    expect(res1?.prompt).toBe('echo "clean temp"');

    const res2 = parseAddScheduleAndPrompt("cleanup @hourly rm -rf /tmp/scratch");
    expect(res2?.id).toBe("cleanup");
    expect(res2?.cronExpression).toBe("@hourly");
    expect(res2?.prompt).toBe("rm -rf /tmp/scratch");
  });

  test("parses /cron edit flags with hyphens in cron expression", () => {
    const res = parseEditFlags('--cron "0 9 * * 1-5" --name "Weekday Report" --mode script');
    expect(res.newCron).toBe("0 9 * * 1-5");
    expect(res.newName).toBe("Weekday Report");
    expect(res.newNoAgent).toBe(true);
  });

  test("parses /cron edit positional schedule", () => {
    const res = parseEditFlags('"0 10 * * *" Update daily stats');
    expect(res.newCron).toBe("0 10 * * *");
    expect(res.newPrompt).toBe("Update daily stats");
  });

  test("parses /cron edit prompt only (when no cron is given)", () => {
    const res = parseEditFlags('Tampilkan ringkasan berita AI terbaru');
    expect(res.newCron).toBeUndefined();
    expect(res.newPrompt).toBe("Tampilkan ringkasan berita AI terbaru");
  });
});
