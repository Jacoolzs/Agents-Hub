export type IconName =
  | "hub"
  | "messages"
  | "agents"
  | "locks"
  | "members"
  | "folder"
  | "logout"
  | "search"
  | "send";

const paths: Record<IconName, string> = {
  hub: "M6 6h4v4H6z M14 14h4v4h-4z M8 10v6h6 M14 6h4v4h-4z M10 8h4 M16 10v4",
  messages: "M5 4h14v12H9l-4 4V4z M8 8h8 M8 12h5",
  agents:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  locks: "M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3",
  members: "M4 5h16v14H4z M8 9h2 M8 13h2 M14 9h3 M14 13h3",
  folder: "M3 6h7l2 2h9v12H3V6z",
  logout: "M10 4H4v16h6 M14 8l4 4-4 4 M8 12h10",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5",
  send: "M3 3l18 9-18 9 4-9-4-9z M7 12h14",
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
