// STUDIO-0075: the same cases with KEEP_SESSION_AFTER_PERSON_STOP off, the product's own rule after a person's stop.
// The switch is a constant; this file runs late-result-session-kept.test.ts again with the module read as if it were
// off, so that the owner's decision can be reversed by one line without a new proof.
process.env.PAPERCLIP_TEST_PERSON_STOP = "off";
await import("./late-result-session-kept.test.ts");
