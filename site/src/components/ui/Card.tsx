import React from 'react'
import { motion } from 'framer-motion'

interface CardProps {
  children: React.ReactNode
  className?: string
  variant?: 'default' | 'green' | 'red'
  hover?: boolean
}

export function Card({ children, className = '', variant = 'default', hover = false }: CardProps) {
  const variantStyle =
    variant === 'green'
      ? { borderColor: 'rgba(22,163,74,0.2)' }
      : variant === 'red'
      ? { borderColor: 'rgba(220,38,38,0.2)' }
      : {}

  if (hover) {
    return (
      <motion.div
        className={`card p-5 ${className}`}
        style={variantStyle}
        whileHover={{ borderColor: 'rgba(91,108,248,0.35)', y: -2, boxShadow: '0 4px 16px rgba(0,0,0,0.12)' }}
        transition={{ duration: 0.2 }}
      >
        {children}
      </motion.div>
    )
  }

  return (
    <div className={`card p-5 ${className}`} style={variantStyle}>
      {children}
    </div>
  )
}
