package service

import (
	"context"
	"testing"
	"time"

	"github.com/Tencent/WeKnora/internal/application/access"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	"github.com/stretchr/testify/require"
)

type uploadPreflightRepo struct {
	interfaces.KnowledgeRepository
	rows   []*types.Knowledge
	tenant uint64
	kb     string
	hashes []string
	calls  int
}

func (r *uploadPreflightRepo) FindFileDuplicates(_ context.Context, tenant uint64, kb string, hashes []string) ([]*types.Knowledge, error) {
	r.calls++
	r.tenant, r.kb, r.hashes = tenant, kb, hashes
	return r.rows, nil
}

func TestPreflightFileUploadsRequiresWriteAndMatchesType(t *testing.T) {
	kb := &types.KnowledgeBase{ID: "kb", TenantID: 7}
	repo := &uploadPreflightRepo{rows: []*types.Knowledge{{ID: "old", FileHash: "d41d8cd98f00b204e9800998ecf8427e", FileType: "pdf", FileName: "old.pdf", FolderPath: "k5"}}}
	svc := &knowledgeService{repo: repo, kbService: &createKnowledgeFileKBServiceStub{kb: kb}}
	files := []types.UploadFingerprint{
		{ID: "renamed", FileHash: "D41D8CD98F00B204E9800998ECF8427E", FileType: "PDF"},
		{ID: "different-type", FileHash: "d41d8cd98f00b204e9800998ecf8427e", FileType: "txt"},
	}
	_, err := svc.PreflightFileUploads(types.WithExecutionTenant(context.Background(), 7), "kb", files)
	require.ErrorIs(t, err, access.ErrForbidden)
	require.Zero(t, repo.calls)
	ctx, err := access.WithKBTaskWrite(context.Background(), kb, 7)
	require.NoError(t, err)
	results, err := svc.PreflightFileUploads(ctx, "kb", files)
	require.NoError(t, err)
	require.Equal(t, uint64(7), repo.tenant)
	require.Equal(t, "kb", repo.kb)
	require.Equal(t, "d41d8cd98f00b204e9800998ecf8427e", repo.hashes[0])
	require.Equal(t, []types.UploadPreflightResult{{ID: "renamed", Duplicate: true, KnowledgeID: "old", FileName: "old.pdf", FolderPath: "k5"}, {ID: "different-type"}}, results)
	_, err = svc.PreflightFileUploads(ctx, "kb", make([]types.UploadFingerprint, 201))
	require.Error(t, err)
	require.Equal(t, 1, repo.calls)
}

type duplicateUploadRepo struct {
	createKnowledgeFileRepoStub
	existing *types.Knowledge
	updates  int
}

func (r *duplicateUploadRepo) CheckKnowledgeExists(context.Context, uint64, string, *types.KnowledgeCheckParams) (bool, *types.Knowledge, error) {
	return true, r.existing, nil
}
func (r *duplicateUploadRepo) UpdateKnowledgeColumn(context.Context, string, string, interface{}) error {
	r.updates++
	return nil
}

func TestCreateKnowledgeFromFileDuplicateDoesNotMutateOrEnqueue(t *testing.T) {
	created := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	repo := &duplicateUploadRepo{existing: &types.Knowledge{ID: "old", CreatedAt: created}}
	fileSvc := &createKnowledgeFileServiceStub{}
	queue := &createKnowledgeTaskEnqueuerStub{}
	svc := &knowledgeService{repo: repo, kbService: &createKnowledgeFileKBServiceStub{kb: &types.KnowledgeBase{ID: "kb-1"}}, fileSvc: fileSvc, task: queue}
	result, err := svc.CreateKnowledgeFromFile(newCreateKnowledgeFileContext(), "kb-1", newMultipartFileHeader(t, "doc.txt", "hello"), nil, nil, "", nil, "", nil)
	require.Error(t, err)
	require.Equal(t, "old", result.ID)
	require.Equal(t, created, result.CreatedAt)
	require.Zero(t, repo.updates)
	require.Zero(t, repo.createCalls)
	require.Zero(t, fileSvc.saveCalls)
	require.Zero(t, queue.calls)
}
