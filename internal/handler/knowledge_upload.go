package handler

import (
	"net/http"

	"github.com/Tencent/WeKnora/internal/errors"
	"github.com/Tencent/WeKnora/internal/types"
	"github.com/gin-gonic/gin"
)

// PreflightFileUploads checks fingerprints with the same access boundary as upload.
// @Summary      批量检查上传文件重复
// @Description  根据 MD5 和文件类型检查当前知识库中的非 failed 文件，不接收文件正文，不修改已有文档。正式上传仍校验重复。
// @Tags         知识管理
// @Accept       json
// @Produce      json
// @Param        id       path      string                       true  "知识库 ID"
// @Param        request  body      types.UploadPreflightRequest true  "1 至 200 个文件指纹，候选 ID 不可重复"
// @Success      200      {object}  map[string]interface{}       "按候选 ID 返回重复检查结果"
// @Failure      400      {object}  errors.AppError               "无效指纹或超出批量限制"
// @Failure      403      {object}  errors.AppError               "无上传权限"
// @Security     Bearer
// @Security     ApiKeyAuth
// @Router       /knowledge-bases/{id}/knowledge/file/preflight [post]
func (h *KnowledgeHandler) PreflightFileUploads(c *gin.Context) {
	_, kbID, tenantID, permission, err := h.validateKnowledgeBaseWriteAccessWithKBID(c, c.Param("id"))
	if err != nil {
		_ = c.Error(err)
		return
	}
	if permission != types.OrgRoleAdmin && permission != types.OrgRoleEditor {
		_ = c.Error(errors.NewForbiddenError("No permission to upload knowledge"))
		return
	}
	var body types.UploadPreflightRequest
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128*1024)
	if err := c.ShouldBindJSON(&body); err != nil {
		_ = c.Error(errors.NewBadRequestError("Expected 1 to 200 valid file fingerprints"))
		return
	}
	seen := make(map[string]bool, len(body.Files))
	for _, file := range body.Files {
		if seen[file.ID] {
			_ = c.Error(errors.NewBadRequestError("Fingerprint IDs must be unique"))
			return
		}
		seen[file.ID] = true
	}
	ctx := types.WithExecutionTenant(c.Request.Context(), tenantID)
	results, err := h.kgService.PreflightFileUploads(ctx, kbID, body.Files)
	if err != nil {
		_ = c.Error(err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "data": results})
}
