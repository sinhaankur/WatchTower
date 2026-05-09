import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import apiClient from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type AcceptResponse = {
  member: { id: string; org_id: string };
  org_id: string;
  org_name: string;
};

const InviteAccept = () => {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'pending' | 'accepted' | 'gone' | 'notfound' | 'duplicate' | 'wrong_email' | 'error'>('pending');
  const [orgName, setOrgName] = useState('');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('notfound');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const resp = await apiClient.post<AcceptResponse>(`/invitations/${encodeURIComponent(token)}/accept`);
        if (cancelled) return;
        setOrgName(resp.data.org_name);
        setStatus('accepted');
        window.setTimeout(() => navigate('/team', { replace: true }), 1500);
      } catch (err) {
        if (cancelled) return;
        const code = (err as { response?: { status?: number } })?.response?.status;
        const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail || '';
        if (code === 404)      setStatus('notfound');
        else if (code === 410) setStatus('gone');
        else if (code === 409) setStatus('duplicate');
        else if (code === 403) setStatus('wrong_email');
        else                   setStatus('error');
        setErrorMessage(detail);
      }
    })();
    return () => { cancelled = true; };
  }, [token, navigate]);

  const title =
    status === 'pending'      ? 'Accepting invitation…'
    : status === 'accepted'    ? `Welcome to ${orgName}`
    : status === 'gone'        ? 'Invitation already used'
    : status === 'duplicate'   ? 'Already a member'
    : status === 'wrong_email' ? 'Wrong account'
    : status === 'notfound'    ? 'Invitation not found'
                               : 'Could not accept invitation';

  const body =
    status === 'pending'      ? 'One moment while we add you to the organization.'
    : status === 'accepted'    ? "You're in. Redirecting to the Team page…"
    : status === 'gone'        ? 'This invitation link has already been redeemed. If you still need access, ask an admin to send a new invite.'
    : status === 'duplicate'   ? errorMessage || 'You already belong to this organization.'
    : status === 'wrong_email' ? errorMessage || 'This invitation was sent to a different email. Sign in with the right account, or ask the inviter to re-send it.'
    : status === 'notfound'    ? 'This invitation link is invalid or has been revoked.'
                               : errorMessage || 'Something went wrong. Try the link again, or ask the inviter to resend it.';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        {status !== 'pending' && status !== 'accepted' && (
          <CardContent>
            <Button onClick={() => navigate('/')}>Go to dashboard</Button>
          </CardContent>
        )}
      </Card>
    </div>
  );
};

export default InviteAccept;
