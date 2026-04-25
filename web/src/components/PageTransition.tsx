import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { useLocation } from 'react-router-dom';

const variants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } },
  exit: { opacity: 0, y: -6, transition: { duration: 0.12, ease: [0.16, 1, 0.3, 1] } },
};

export function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        variants={variants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ width: '100%', height: '100%' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
