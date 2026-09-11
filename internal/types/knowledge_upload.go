package types

// UploadFingerprint carries no body; ID correlates a candidate with its result.
type UploadFingerprint struct {
	ID       string `json:"id" binding:"required,max=128"`
	FileHash string `json:"file_hash" binding:"required,len=32,hexadecimal"`
	FileType string `json:"file_type" binding:"required,max=32,alphanum"`
}

type UploadPreflightRequest struct {
	Files []UploadFingerprint `json:"files" binding:"required,min=1,max=200,dive"`
}

type UploadPreflightResult struct {
	ID          string `json:"id"`
	Duplicate   bool   `json:"duplicate"`
	KnowledgeID string `json:"knowledge_id,omitempty"`
	FileName    string `json:"file_name,omitempty"`
	FolderPath  string `json:"folder_path,omitempty"`
}
