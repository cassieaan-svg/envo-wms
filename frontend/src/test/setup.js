// jsdom has no IndexedDB implementation at all; fake-indexeddb is a real (in-memory)
// implementation of the same spec, so offlineDb.js runs against it completely
// unmodified — these tests exercise the actual production code, not a mock of it.
import 'fake-indexeddb/auto'
