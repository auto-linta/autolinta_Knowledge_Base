package repository

import (
	"context"

	"github.com/Tencent/WeKnora/internal/types"
)

func (r *knowledgeRepository) FindFileDuplicates(ctx context.Context, tenantID uint64, kbID string, hashes []string) ([]*types.Knowledge, error) {
	rows := make([]*types.Knowledge, 0)
	if len(hashes) == 0 {
		return rows, nil
	}
	err := r.db.WithContext(ctx).Model(&types.Knowledge{}).
		Select("id", "file_hash", "file_type", "file_name", "folder_path").
		Where("tenant_id = ? AND knowledge_base_id = ? AND type = ? AND parse_status <> ? AND file_hash IN ?", tenantID, kbID, "file", "failed", hashes).
		Order("created_at ASC, id ASC").Find(&rows).Error
	return rows, err
}
