import React, { useState } from "react";
import { useAuthStore } from "../stores/authStore";
import "./OnboardingModal.css";

const OCCUPATIONS = [
  { id: "student", label: "Student" },
  { id: "professional", label: "Professional" },
  { id: "freelancer", label: "Freelancer" },
  { id: "researcher", label: "Researcher" },
  { id: "educator", label: "Educator" },
  { id: "hobbyist", label: "Hobbyist" },
  { id: "other", label: "Other" },
] as const;

const FIELDS = [
  { id: "software", label: "Software & Engineering" },
  { id: "design", label: "Design & Creative" },
  { id: "business", label: "Business & Finance" },
  { id: "science", label: "Science & Research" },
  { id: "healthcare", label: "Healthcare" },
  { id: "education", label: "Education" },
  { id: "legal", label: "Legal" },
  { id: "other", label: "Other" },
] as const;

const OnboardingModal: React.FC = () => {
  const profile = useAuthStore((s) => s.profile);
  const loading = useAuthStore((s) => s.loading);
  const error = useAuthStore((s) => s.error);
  const completeOnboarding = useAuthStore((s) => s.completeOnboarding);
  const clearError = useAuthStore((s) => s.clearError);
  const [step, setStep] = useState<0 | 1>(0);
  const [occupation, setOccupation] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);

  if (!profile || profile.onboardingCompleted !== false) return null;

  const options = step === 0 ? OCCUPATIONS : FIELDS;
  const selected = step === 0 ? occupation : field;

  const skip = async () => {
    clearError();
    try {
      await completeOnboarding({ completeOnboarding: true });
    } catch {
      // error in store
    }
  };

  const next = async () => {
    clearError();
    try {
      if (step === 0) {
        if (occupation) {
          await completeOnboarding({ occupation });
        }
        setStep(1);
        return;
      }
      await completeOnboarding({
        ...(field ? { field } : {}),
        completeOnboarding: true,
      });
    } catch {
      // error in store
    }
  };

  return (
    <div className="onboarding-modal-overlay" role="dialog" aria-modal="true">
      <div className="onboarding-modal">
        <p className="onboarding-step">Step {step + 1} of 2</p>
        <h2>
          {step === 0 ? "What best describes you?" : "What field are you in?"}
        </h2>
        <p className="onboarding-copy">
          {step === 0
            ? "This helps us tailor NELA to how you work."
            : "Pick the area closest to your work or studies."}
        </p>
        <div className="onboarding-options">
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className={selected === opt.id ? "is-selected" : ""}
              disabled={loading}
              onClick={() => {
                if (step === 0) setOccupation(opt.id);
                else setField(opt.id);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {error ? <p className="onboarding-error">{error}</p> : null}
        <div className="onboarding-actions">
          <button type="button" className="onboarding-skip" disabled={loading} onClick={() => void skip()}>
            Skip
          </button>
          <button type="button" className="onboarding-next" disabled={loading} onClick={() => void next()}>
            {loading ? "Saving…" : step === 1 ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingModal;
