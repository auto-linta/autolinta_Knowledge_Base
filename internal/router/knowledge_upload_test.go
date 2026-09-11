package router

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Tencent/WeKnora/internal/config"
	"github.com/Tencent/WeKnora/internal/handler"
	"github.com/Tencent/WeKnora/internal/middleware"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestPreflightFileUploadsRouteRejectsViewerBeforeHandler(t *testing.T) {
	// Tenant roles are enforced by the same route ownership guard as POST /file.
	enabled := true
	guards := &rbacGuards{
		cfg:       &config.Config{Tenant: &config.TenantConfig{EnableRBAC: &enabled}},
		kbCreator: func(*gin.Context) (string, error) { return "another-owner", nil },
	}
	engine := gin.New()
	engine.Use(middleware.ErrorHandler(), func(c *gin.Context) {
		ctx := types.WithCaller(c.Request.Context(), types.Caller{TenantID: 1, UserID: "viewer", Role: types.TenantRoleViewer})
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	})
	RegisterKnowledgeRoutes(engine.Group("/api/v1"), &handler.KnowledgeHandler{}, guards)
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/knowledge-bases/kb-own/knowledge/file/preflight", nil))
	require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
}
