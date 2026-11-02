# Sync moves filed Documents to the Archive, it does not mirror

The Rust sync binary is one-way and additive towards the Archive, and it removes each source file once that file exists byte-identically in the Archive (copied there by this run or already present). The server's output folder is therefore a transient staging area, not a second copy: the Archive in Proton Drive is the single durable store, and nothing accumulates on the server. The binary never deletes in the Archive; a name collision with different content keeps both (`name (1).pdf`) and then removes the source.
