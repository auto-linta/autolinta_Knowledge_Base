package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Tencent/WeKnora/internal/application/access"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/Tencent/WeKnora/internal/types/interfaces"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type preflightHandlerService struct {
	interfaces.KnowledgeService
	calls int
}

func TestPreflightFileUploadsRejectsReadOnlyAndOutOfScopeKeys(t *testing.T) {
	for _, tc := range []struct {
		name  string
		role  types.TenantRole
		scope *types.TenantAPIKeyScope
	}{
		{name: "wrong KB key", role: types.TenantRoleAdmin, scope: &types.TenantAPIKeyScope{Capabilities: types.StringArray{string(types.APIKeyCapabilityIngest)}, KnowledgeBaseIDs: types.StringArray{"another-kb"}}},
		{name: "retrieve-only key", role: types.TenantRoleAdmin, scope: &types.TenantAPIKeyScope{Capabilities: types.StringArray{string(types.APIKeyCapabilityRetrieve)}, KnowledgeBaseIDs: types.StringArray{"kb"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &preflightHandlerService{}
			h := &KnowledgeHandler{kgService: svc, kbService: &stubKBService{get: func(context.Context, string) (*types.KnowledgeBase, error) {
				return &types.KnowledgeBase{ID: "kb", TenantID: 7}, nil
			}}}
			r := documentHandlerRouter()
			r.Use(func(c *gin.Context) {
				ctx := types.WithCaller(c.Request.Context(), types.Caller{TenantID: 7, UserID: "user", Role: tc.role})
				if tc.scope != nil {
					ctx = types.WithTenantAPIKeyScope(ctx, *tc.scope)
				}
				c.Request = c.Request.WithContext(ctx)
				c.Next()
			})
			r.POST("/:id/preflight", h.PreflightFileUploads)
			req := httptest.NewRequest(http.MethodPost, "/kb/preflight", strings.NewReader(`{"files":[{"id":"a","file_hash":"d41d8cd98f00b204e9800998ecf8427e","file_type":"pdf"}]}`))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
			require.Zero(t, svc.calls)
		})
	}
}

func (s *preflightHandlerService) PreflightFileUploads(ctx context.Context, id string, files []types.UploadFingerprint) ([]types.UploadPreflightResult, error) {
	if err := access.RequireKBWrite(ctx, &types.KnowledgeBase{ID: id, TenantID: 7}); err != nil {
		return nil, err
	}
	s.calls++
	return []types.UploadPreflightResult{{ID: files[0].ID, Duplicate: true, KnowledgeID: "old", FileName: "existing.pdf"}}, nil
}

func TestPreflightFileUploadsHandlerValidationAndGrant(t *testing.T) {
	valid := `{"files":[{"id":"a","file_hash":"d41d8cd98f00b204e9800998ecf8427e","file_type":"pdf"}]}`
	tooMany := make([]types.UploadFingerprint, 201)
	for i := range tooMany {
		tooMany[i] = types.UploadFingerprint{ID: "a", FileHash: "d41d8cd98f00b204e9800998ecf8427e", FileType: "pdf"}
	}
	large, err := json.Marshal(map[string]any{"files": tooMany})
	require.NoError(t, err)
	for _, tc := range []struct {
		name, body string
		tenant     uint64
		status     int
	}{
		{"valid", valid, 7, http.StatusOK},
		{"empty", `{"files":[]}`, 7, http.StatusBadRequest},
		{"invalid hash", strings.Replace(valid, "d41d8cd98f00b204e9800998ecf8427e", "invalid", 1), 7, http.StatusBadRequest},
		{"duplicate IDs", strings.Replace(valid, "]}", `,{"id":"a","file_hash":"d41d8cd98f00b204e9800998ecf8427e","file_type":"pdf"}]}`, 1), 7, http.StatusBadRequest},
		{"too many", string(large), 7, http.StatusBadRequest},
		{"foreign KB", valid, 8, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &preflightHandlerService{}
			h := &KnowledgeHandler{kgService: svc, kbService: &stubKBService{get: func(context.Context, string) (*types.KnowledgeBase, error) {
				return &types.KnowledgeBase{ID: "kb", TenantID: tc.tenant}, nil
			}}}
			r := documentHandlerRouter()
			r.POST("/:id/preflight", h.PreflightFileUploads)
			req := httptest.NewRequest(http.MethodPost, "/kb/preflight", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			require.Equal(t, tc.status, w.Code, w.Body.String())
			if tc.status == http.StatusOK {
				require.Equal(t, 1, svc.calls)
				require.Contains(t, w.Body.String(), `"duplicate":true`)
			} else {
				require.Zero(t, svc.calls)
			}
		})
	}
}
