package repository

import (
	"context"
	"testing"

	"github.com/Tencent/WeKnora/internal/types"
	"github.com/stretchr/testify/require"
)

func TestFindFileDuplicatesMatchesUploadScopeAndStatus(t *testing.T) {
	db := setupKnowledgeTestDB(t)
	repo := NewKnowledgeRepository(db)
	const hash = "d41d8cd98f00b204e9800998ecf8427e"
	for _, row := range []struct {
		id, kb, kind, status string
		tenant               int
		deleted              bool
	}{
		{"pending", "kb", "file", "pending", 7, false},
		{"processing", "kb", "file", "processing", 7, false},
		{"completed", "kb", "file", "completed", 7, false},
		{"cancelled", "kb", "file", "cancelled", 7, false},
		{"failed", "kb", "file", "failed", 7, false},
		{"other-kb", "other", "file", "completed", 7, false},
		{"other-tenant", "kb", "file", "completed", 8, false},
		{"url", "kb", "url", "completed", 7, false},
		{"deleted", "kb", "file", "completed", 7, true},
	} {
		require.NoError(t, db.Exec(`INSERT INTO knowledges (id, tenant_id, knowledge_base_id, type, title, file_name, folder_path, file_type, file_hash, parse_status)
		VALUES (?, ?, ?, ?, 'manual', 'manual.pdf', 'k5/2018', 'pdf', ?, ?)`, row.id, row.tenant, row.kb, row.kind, hash, row.status).Error)
		if row.deleted {
			require.NoError(t, db.Exec("UPDATE knowledges SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", row.id).Error)
		}
	}
	rows, err := repo.FindFileDuplicates(context.Background(), 7, "kb", []string{hash})
	require.NoError(t, err)
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
		require.Equal(t, "manual.pdf", row.FileName)
		require.Equal(t, "k5/2018", row.FolderPath)
	}
	require.ElementsMatch(t, []string{"pending", "processing", "completed", "cancelled"}, ids)
	exists, _, err := repo.CheckKnowledgeExists(context.Background(), 7, "kb", &types.KnowledgeCheckParams{Type: "file", FileType: "pdf", FileHash: hash})
	require.NoError(t, err)
	require.True(t, exists)
	empty, err := repo.FindFileDuplicates(context.Background(), 7, "kb", nil)
	require.NoError(t, err)
	require.Empty(t, empty)
}
