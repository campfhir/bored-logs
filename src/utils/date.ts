export function parseDate(date: unknown): Date | null {
  if (date === null || date === undefined) return null;
  if (typeof date === "string" && !validateISO(date)) return null;
  if (typeof date === "string") return new Date(date);
  if (date instanceof Date) return date;
  return null;
}

export function validRFCDate(date: unknown): date is string | Date {
  if (
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
  ) {
    return true;
  }
  if (date instanceof Date) {
    return true;
  }
  return false;
}

export function validateISO(date: unknown): date is string {
  return (
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date)
  );
}
