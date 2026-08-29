use std::{
    collections::{HashSet, VecDeque},
    sync::Mutex,
};

use tokio::sync::Notify;

use super::mutex_lock;

/// A deduplicating two-level queue shared by thumbnail and embedding workers.
#[derive(Default)]
pub(crate) struct PriorityQueue {
    state: Mutex<QueueState>,
    notify: Notify,
}

#[derive(Default)]
struct QueueState {
    urgent: VecDeque<String>,
    background: VecDeque<String>,
    queued: HashSet<String>,
}

impl PriorityQueue {
    pub(crate) fn retain(&self, valid_ids: &HashSet<&str>) {
        let mut state = mutex_lock(&self.state);
        state.urgent.retain(|id| valid_ids.contains(id.as_str()));
        state
            .background
            .retain(|id| valid_ids.contains(id.as_str()));
        state.queued.retain(|id| valid_ids.contains(id.as_str()));
    }

    pub(crate) fn push_urgent(&self, id: String) {
        {
            let mut state = mutex_lock(&self.state);
            if state.queued.contains(&id) {
                let Some(position) = state.background.iter().position(|queued| queued == &id)
                else {
                    return;
                };
                state.background.remove(position);
            } else {
                state.queued.insert(id.clone());
            }
            state.urgent.push_back(id);
        }
        self.notify.notify_one();
    }

    pub(crate) fn push_background(&self, id: String) {
        let inserted = {
            let mut state = mutex_lock(&self.state);
            let inserted = state.queued.insert(id.clone());
            if inserted {
                state.background.push_back(id);
            }
            inserted
        };
        if inserted {
            self.notify.notify_one();
        }
    }

    pub(crate) async fn pop(&self) -> String {
        loop {
            // Register before inspecting the queue so a producer cannot notify
            // between the empty check and this worker going to sleep.
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(id) = {
                let mut state = mutex_lock(&self.state);
                let id = state
                    .urgent
                    .pop_front()
                    .or_else(|| state.background.pop_front());
                if let Some(id) = &id {
                    state.queued.remove(id);
                }
                id
            } {
                return id;
            }
            notified.as_mut().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashSet, sync::Arc, time::Duration};

    use super::PriorityQueue;

    #[tokio::test]
    async fn urgent_jobs_are_promoted_without_duplicates() {
        let queue = PriorityQueue::default();
        queue.push_background("background".to_owned());
        queue.push_background("promoted".to_owned());
        queue.push_urgent("promoted".to_owned());
        queue.push_urgent("promoted".to_owned());

        assert_eq!(queue.pop().await, "promoted");
        assert_eq!(queue.pop().await, "background");
    }

    #[tokio::test]
    async fn wakes_each_waiting_worker() {
        let queue = Arc::new(PriorityQueue::default());
        let first = {
            let queue = Arc::clone(&queue);
            tokio::spawn(async move { queue.pop().await })
        };
        let second = {
            let queue = Arc::clone(&queue);
            tokio::spawn(async move { queue.pop().await })
        };
        tokio::task::yield_now().await;

        queue.push_background("one".to_owned());
        queue.push_background("two".to_owned());

        let mut jobs = [
            tokio::time::timeout(Duration::from_secs(1), first)
                .await
                .expect("first worker timed out")
                .expect("first worker stopped"),
            tokio::time::timeout(Duration::from_secs(1), second)
                .await
                .expect("second worker timed out")
                .expect("second worker stopped"),
        ];
        jobs.sort();
        assert_eq!(jobs, ["one", "two"]);
    }

    #[tokio::test]
    async fn removes_jobs_that_are_no_longer_valid() {
        let queue = PriorityQueue::default();
        queue.push_urgent("removed".to_owned());
        queue.push_background("kept".to_owned());
        queue.retain(&HashSet::from(["kept"]));

        assert_eq!(queue.pop().await, "kept");
    }
}
