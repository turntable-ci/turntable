import { expect, test } from "bun:test";
import { registry } from "../src/ops";

// Edit this list only after review. Every entry gives up the dispatcher's atomic op + audit row.
const ALLOWED_OUTSIDE_TRANSACTION = [
  "add_project", // asks GitHub whether the installation reaches the repo first; all writes are one inner transaction
  "bind_installation", // reads GitHub with the user's token (several calls) before and while it syncs; a partial bind is repaired by running it again (sync is idempotent)
  "db_backup", // cannot run inside a transaction
  "instance_bind_installation", // reads GitHub (installation facts, then the sync's repo list) before and while it syncs, which must not hold the write lock; the sync is idempotent so a partial bind is repaired by running it again, and the audit row and event are written in one db.transaction
  "instance_db_copy", // minutes of batched work that yields between batches, on its own connections to the target; it only reads the SQLite file, and the dispatcher's exclusive write transaction would stop every other request for the whole copy; the audit row follows in its own short transaction
  "instance_replace_app_private_key", // calls GET /app on GitHub to verify the new key before the swap, which must not hold the write lock; the seal and the swap are one db.transaction after the verification, and the audit row follows in its own short transaction
  "instance_rotate_webhook_secret", // PATCHes the new secret to GitHub (/app/hook/config), which must not hold the write lock; the seal commits first and a GitHub refusal restores the old secret and expiry, and the audit row follows in its own short transaction
  "log_store_migrate", // copies logs to the external store over HTTP for minutes; must not hold the write lock
  "onboard_repos", // asks GitHub for the installation's repos first; all writes are one inner transaction (all or nothing)
  "register_sandbox_image", // asks the sandbox provider to build a snapshot (Daytona POST /snapshots, up to 60 s), which must not hold the write lock; the record, project pointer and project audit row are one db.transaction after the provider answers, and the dispatcher audits the call in its own short transaction
  "release_cosign_key_remove", // same: a lane channel round trip
  "release_cosign_key_set", // same: a lane channel round trip; the lane's own file changes, not this database
  "release_init_key", // same: a lane channel round trip; the key is generated and sealed in the lane's own directory, not in this database
  "release_pin_repo", // a message to the release lane over its channel must not hold the DB write lock; the lane's own file is what changes, not this database
  "release_publish_target_delete", // same: a lane channel round trip
  "release_publish_target_set", // same: a lane channel round trip
  "release_secret_set", // same: a lane channel round trip, and the vault write is the lane's own
  "release_set_project_signing", // lane channel round trips (check the key, bump the version) around one project row write: they must not hold the DB write lock
  "resync_installation", // makes GitHub API calls, which must not hold the write transaction
  "run_default_branch", // forge round trips (head, workflow) must not hold the DB write lock; the run is written in the poller path's own transaction
  "run_dispatch", // forge round trips (ref resolve, workflow fetch) must not hold the DB write lock; all writes are in one inner transaction
];

test("only allowlisted ops run outside the dispatcher's transaction", () => {
  const actual = registry.ops
    .filter((op) => op.outsideTransaction)
    .map((op) => op.name)
    .sort();
  expect(
    actual,
    [
      "The set of ops with outsideTransaction: true changed.",
      "An op with this flag runs without the dispatcher's write transaction, so its audit row is",
      "written afterwards in a separate transaction: the op and its audit row are no longer atomic,",
      "and if the handler fails part way, its partial effects stay committed with no rollback.",
      "Only add an op here if it cannot run inside a transaction (like db_backup) and a reviewer",
      "has accepted that trade. Otherwise remove outsideTransaction from the op.",
    ].join("\n"),
  ).toEqual(ALLOWED_OUTSIDE_TRANSACTION);
});
