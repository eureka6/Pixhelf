use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use async_trait::async_trait;
use tower_sessions::{
    SessionStore,
    cookie::time::OffsetDateTime,
    session::{Id, Record},
    session_store,
};

use crate::support::mutex_lock;

const MAX_SESSIONS: usize = 128;
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(12 * 60 * 60);
const ABSOLUTE_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 60 * 60);

struct StoredSession {
    record: Record,
    created: Instant,
    last_seen: Instant,
}

impl StoredSession {
    fn active(&self, now: Instant) -> bool {
        now.duration_since(self.created) < ABSOLUTE_TIMEOUT
            && now.duration_since(self.last_seen) < IDLE_TIMEOUT
            && self.record.expiry_date > OffsetDateTime::now_utc()
    }
}

/// Single-process sessions: bounded memory, monotonic lifetimes, and no resurrection after logout.
#[derive(Clone, Default)]
pub struct SessionMemory(Arc<Mutex<HashMap<Id, StoredSession>>>);

impl SessionMemory {
    pub(super) fn revoke_all(&self) {
        mutex_lock(&self.0).clear();
    }
}

impl fmt::Debug for SessionMemory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionMemory")
            .field("count", &mutex_lock(&self.0).len())
            .finish()
    }
}

#[async_trait]
impl SessionStore for SessionMemory {
    async fn create(&self, record: &mut Record) -> session_store::Result<()> {
        let now = Instant::now();
        let mut sessions = mutex_lock(&self.0);
        sessions.retain(|_, session| session.active(now));
        while sessions.contains_key(&record.id) {
            record.id = Id::default();
        }
        if sessions.len() >= MAX_SESSIONS
            && let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, session)| session.last_seen)
                .map(|(id, _)| *id)
        {
            sessions.remove(&oldest);
        }
        sessions.insert(
            record.id,
            StoredSession {
                record: record.clone(),
                created: now,
                last_seen: now,
            },
        );
        Ok(())
    }

    async fn save(&self, record: &Record) -> session_store::Result<()> {
        let now = Instant::now();
        let mut sessions = mutex_lock(&self.0);
        if let Some(existing) = sessions.get_mut(&record.id) {
            if existing.active(now) {
                existing.record = record.clone();
                existing.last_seen = now;
            } else {
                sessions.remove(&record.id);
            }
        }
        // An in-flight request may finish after logout. Updating must never recreate its session.
        Ok(())
    }

    async fn load(&self, id: &Id) -> session_store::Result<Option<Record>> {
        let mut sessions = mutex_lock(&self.0);
        if sessions
            .get(id)
            .is_some_and(|session| !session.active(Instant::now()))
        {
            sessions.remove(id);
        }
        Ok(sessions.get(id).map(|session| session.record.clone()))
    }

    async fn delete(&self, id: &Id) -> session_store::Result<()> {
        mutex_lock(&self.0).remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> Record {
        Record {
            id: Id::default(),
            data: HashMap::new(),
            expiry_date: OffsetDateTime::now_utc()
                + tower_sessions::cookie::time::Duration::hours(12),
        }
    }

    #[tokio::test]
    async fn concurrent_save_cannot_resurrect_a_logged_out_session() {
        let store = SessionMemory::default();
        let mut record = record();
        store.create(&mut record).await.unwrap();
        let in_flight = store.load(&record.id).await.unwrap().unwrap();
        store.delete(&record.id).await.unwrap();
        store.save(&in_flight).await.unwrap();
        assert!(store.load(&record.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn idle_absolute_and_wall_clock_expiry_cannot_be_extended_by_stale_requests() {
        for kind in 0..3 {
            let store = SessionMemory::default();
            let mut record = record();
            store.create(&mut record).await.unwrap();
            {
                let mut sessions = mutex_lock(&store.0);
                let stored = sessions.get_mut(&record.id).unwrap();
                match kind {
                    0 => stored.last_seen -= IDLE_TIMEOUT,
                    1 => stored.created -= ABSOLUTE_TIMEOUT,
                    _ => {
                        stored.record.expiry_date = OffsetDateTime::now_utc()
                            - tower_sessions::cookie::time::Duration::seconds(1)
                    }
                }
            }
            store.save(&record).await.unwrap();
            assert!(store.load(&record.id).await.unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn session_capacity_evicts_oldest_and_collisions_receive_new_ids() {
        let store = SessionMemory::default();
        let mut oldest = record();
        store.create(&mut oldest).await.unwrap();
        mutex_lock(&store.0).get_mut(&oldest.id).unwrap().last_seen -= Duration::from_secs(1);
        let mut collision = oldest.clone();
        store.create(&mut collision).await.unwrap();
        assert_ne!(collision.id, oldest.id);
        for _ in 2..=MAX_SESSIONS {
            store.create(&mut record()).await.unwrap();
        }
        assert_eq!(mutex_lock(&store.0).len(), MAX_SESSIONS);
        assert!(store.load(&oldest.id).await.unwrap().is_none());
        assert!(store.load(&collision.id).await.unwrap().is_some());
        store.save(&oldest).await.unwrap();
        assert!(store.load(&oldest.id).await.unwrap().is_none());
    }
}
