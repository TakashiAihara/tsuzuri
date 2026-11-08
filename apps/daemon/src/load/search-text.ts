/** Strip markup down to the text pgroonga will index. */
export function toSearchText(
  title: string | null,
  html: string | null,
  summary: string | null,
): string {
  const body = html ?? summary ?? "";
  const stripped = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/g, " ");
  return [title ?? "", stripped].join(" ").replace(/\s+/g, " ").trim();
}
