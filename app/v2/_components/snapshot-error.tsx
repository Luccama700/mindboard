/**
 * What a v2 page shows when its snapshot folder cannot be read: the one error
 * the folder reported, and where to go and fix it.
 *
 * Shared by Today and Week, so the two pages cannot come to say different
 * things about the same folder. It reads nothing and imports nothing that does:
 * the message is handed in by the guarded half of the page that hit the error.
 * Plain inline styles, because it renders when the screen itself could not be
 * built.
 */
export function SnapshotError({ message }: { message: string }) {
  return (
    <main style={{ padding: "2rem 1rem", maxWidth: "34rem", lineHeight: 1.5 }}>
      <h1 style={{ fontSize: "1.1rem", fontWeight: 700 }}>The snapshot is not ready</h1>
      <p style={{ marginTop: "0.75rem" }}>{message}</p>
      <p style={{ marginTop: "0.75rem", opacity: 0.7 }}>
        The folder is the one V2_LOCAL_SNAPSHOT points at. Nothing was changed in it.
      </p>
    </main>
  );
}
