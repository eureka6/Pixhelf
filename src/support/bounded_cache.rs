use std::collections::{HashMap, VecDeque};

/// A small string-keyed LRU cache. Keeping ordering here avoids the arbitrary
/// HashMap eviction previously repeated by ranking and descriptor caches.
pub(crate) struct BoundedCache<V> {
    capacity: usize,
    entries: HashMap<String, V>,
    order: VecDeque<String>,
}

impl<V> BoundedCache<V> {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    pub(crate) fn get_cloned(&mut self, key: &str) -> Option<V>
    where
        V: Clone,
    {
        let value = self.entries.get(key)?.clone();
        self.touch(key);
        Some(value)
    }

    /// Read without changing recency. This keeps lookups O(1) for large,
    /// scan-heavy caches where insertion-order eviction is sufficient.
    pub(crate) fn peek_cloned(&self, key: &str) -> Option<V>
    where
        V: Clone,
    {
        self.entries.get(key).cloned()
    }

    pub(crate) fn insert(&mut self, key: String, value: V) {
        if self.entries.contains_key(&key) {
            self.order.retain(|cached| cached != &key);
        } else if self.entries.len() >= self.capacity
            && let Some(oldest) = self.order.pop_front()
        {
            self.entries.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|cached| cached != key);
        self.order.push_back(key.to_owned());
    }
}

#[cfg(test)]
mod tests {
    use super::BoundedCache;

    #[test]
    fn evicts_the_least_recently_used_entry() {
        let mut cache = BoundedCache::new(2);
        cache.insert("one".to_owned(), 1);
        cache.insert("two".to_owned(), 2);
        assert_eq!(cache.get_cloned("one"), Some(1));

        cache.insert("three".to_owned(), 3);

        assert_eq!(cache.get_cloned("two"), None);
        assert_eq!(cache.get_cloned("one"), Some(1));
        assert_eq!(cache.get_cloned("three"), Some(3));
    }

    #[test]
    fn replacing_an_entry_does_not_evict_another_key() {
        let mut cache = BoundedCache::new(2);
        cache.insert("one".to_owned(), 1);
        cache.insert("two".to_owned(), 2);
        cache.insert("one".to_owned(), 10);

        assert_eq!(cache.get_cloned("one"), Some(10));
        assert_eq!(cache.get_cloned("two"), Some(2));
    }
}
