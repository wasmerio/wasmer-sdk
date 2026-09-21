import "./examples.css";
import catalog from "../examples.json";

export interface ShellExample {
  id: string;
  source: string;
  title: string;
  group: string;
  description: string;
  icon: string;
  color: string;
  dependencies: string;
  packages: string[];
  install: string | null;
  run: string;
}

export const examples: ShellExample[] = catalog;
const sources = import.meta.glob<string>(
  [
    "../workspace/**/*",
    "../workspace/**/.npmrc",
    "!**/node_modules/**",
    "!**/.next/**",
    "!**/__pycache__/**",
    "!**/.python-packages/**",
  ],
  { query: "?raw", import: "default", eager: true },
);

export function exampleFiles(example?: ShellExample): Record<string, string> {
  const prefix = "../workspace/";
  return Object.fromEntries(
    Object.entries(sources)
      .map(([path, contents]) => [path.slice(prefix.length), contents])
      .filter(([path]) => !example || path.startsWith(`${example.source}/`)),
  );
}

export function renderExamples(container: HTMLElement): void {
  for (const group of [...new Set(examples.map((example) => example.group))]) {
    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = group;
    const grid = document.createElement("div");
    grid.className = "example-grid";
    for (const example of examples.filter(
      (example) => example.group === group,
    )) {
      const card = document.createElement("a");
      card.className = "example-card";
      card.dataset.example = example.id;
      card.href = exampleUrl(example.id);
      const icon = document.createElement("span");
      icon.className = "example-icon";
      icon.style.setProperty("--example-color", `#${example.color}`);
      icon.textContent = example.icon;
      icon.setAttribute("aria-hidden", "true");
      const content = document.createElement("span");
      content.className = "example-copy";
      const title = document.createElement("strong");
      title.textContent = example.title;
      const description = document.createElement("span");
      description.textContent = example.description;
      const dependencies = document.createElement("small");
      dependencies.textContent = example.dependencies;
      content.append(title, description, dependencies);
      card.append(icon, content);
      grid.append(card);
    }
    section.append(heading, grid);
    container.append(section);
  }
}

export function exampleUrl(id: string): string {
  const url = new URL(window.location.href);
  for (const key of ["package", "command", "use", "arg"])
    url.searchParams.delete(key);
  url.searchParams.set("example", id);
  return url.pathname + url.search;
}
