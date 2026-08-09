pub mod embeddings;
pub mod hybrid;
pub mod indexer;
pub mod schema;

pub use embeddings::{cosine_similarity, Embedder, SharedEmbedder, EMBED_BATCH_SIZE};
pub use hybrid::{hybrid_search, rrf_fuse, HybridHit};
pub use indexer::{
    expand_query_terms, SharedTantivyIndex, TantivyIndex, BOOST_CONTENT, BOOST_FILE_NAME,
    BOOST_TITLE,
};
