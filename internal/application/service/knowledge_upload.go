package service

import (
	"context"
	"strings"

	"github.com/Tencent/WeKnora/internal/application/access"
	werrors "github.com/Tencent/WeKnora/internal/errors"
	"github.com/Tencent/WeKnora/internal/types"
)

func (s *knowledgeService) PreflightFileUploads(ctx context.Context, kbID string, files []types.UploadFingerprint) ([]types.UploadPreflightResult, error) {
	kb, err := s.kbService.GetKnowledgeBaseByID(ctx, kbID)
	if err != nil {
		return nil, err
	}
	if err := access.RequireKBWrite(ctx, kb); err != nil {
		return nil, err
	}
	if len(files) == 0 || len(files) > 200 {
		return nil, werrors.NewBadRequestError("Expected 1 to 200 file fingerprints")
	}
	hashes := make([]string, 0, len(files))
	for _, file := range files {
		hashes = append(hashes, strings.ToLower(file.FileHash))
	}
	rows, err := s.repo.FindFileDuplicates(ctx, kb.TenantID, kbID, hashes)
	if err != nil {
		return nil, err
	}
	byContent := make(map[string]*types.Knowledge, len(rows))
	for _, row := range rows {
		key := strings.ToLower(row.FileHash) + ":" + strings.ToLower(row.FileType)
		if byContent[key] == nil {
			byContent[key] = row
		}
	}
	results := make([]types.UploadPreflightResult, 0, len(files))
	for _, file := range files {
		result := types.UploadPreflightResult{ID: file.ID}
		if row := byContent[strings.ToLower(file.FileHash)+":"+strings.ToLower(file.FileType)]; row != nil {
			result.Duplicate, result.KnowledgeID, result.FileName, result.FolderPath = true, row.ID, row.FileName, row.FolderPath
		}
		results = append(results, result)
	}
	return results, nil
}
